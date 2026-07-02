"""
Frame capture using OpenCV VideoCapture.

StereoCapturer — two cameras at config.FRAMERATE. Each camera runs in its
own thread so they capture truly in parallel; frames are paired by nearest
timestamp with max skew of one frame interval.

SpinCapturer — optional third camera at config.SPIN_CAM_FPS dedicated to
seam-based spin measurement. Single thread, no pairing; every frame goes
straight to the callback with its capture timestamp.

Exposure is locked to config values so a fast-moving ball stays sharp.
Auto-exposure must be disabled; see config.py for the exposure value range.
"""

import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Callable, Deque, Optional, Tuple

import cv2
import numpy as np

import config


@dataclass
class FramePair:
    left: np.ndarray    # (H, W, 3) BGR
    right: np.ndarray
    timestamp: float    # seconds, monotonic


@dataclass
class SpinFrame:
    frame: np.ndarray   # (H, W, 3) BGR
    timestamp: float    # seconds, monotonic


FramePairCallback = Callable[[FramePair], None]
SpinFrameCallback = Callable[[SpinFrame], None]

# Maximum timestamp skew between L and R frames.
# Floor of 100 ms ensures pairs always emit on slow/dev cameras that don't reach
# the configured frame rate; the actual skew between two running USB cameras is
# always much smaller than this, so ball-tracking accuracy isn't affected.
_MAX_SKEW_S = max(1.0 / config.FRAMERATE, 0.1)


def _make_camera(idx: int, width: int, height: int, fps: float,
                 exposure: float, gain: float) -> cv2.VideoCapture:
    cap = cv2.VideoCapture(idx, config.CAMERA_BACKEND)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open camera index {idx}")

    # MJPEG must be selected BEFORE resolution/fps — these cameras only reach
    # their high frame rates in MJPEG; the uncompressed default caps at ~30 fps.
    if config.CAMERA_FOURCC:
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*config.CAMERA_FOURCC))
    cap.set(cv2.CAP_PROP_FRAME_WIDTH,  width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    cap.set(cv2.CAP_PROP_FPS,          float(fps))

    if config.APPLY_EXPOSURE:
        # Disable auto-exposure then set manual value.
        # 0.25 = manual mode in the V4L2 / DirectShow / MSMF convention.
        cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25)
        cap.set(cv2.CAP_PROP_EXPOSURE, float(exposure))
        if gain >= 0:
            cap.set(cv2.CAP_PROP_GAIN, float(gain))

    return cap


class StereoCapturer:
    """
    Captures synchronised frame pairs from two OpenCV cameras.

    Each camera runs in its own capture thread. A third pairing thread
    matches frames by timestamp and calls on_pair for each valid pair.

    Usage:
        capturer = StereoCapturer(on_pair=my_callback)
        capturer.start()
        ...
        capturer.stop()
    """

    def __init__(self, on_pair: FramePairCallback) -> None:
        self._on_pair  = on_pair
        self._running  = False
        self._cap0: Optional[cv2.VideoCapture] = None
        self._cap1: Optional[cv2.VideoCapture] = None

        # Ring buffers — each camera thread writes here
        self._buf0: Deque[Tuple[float, np.ndarray]] = deque(maxlen=16)
        self._buf1: Deque[Tuple[float, np.ndarray]] = deque(maxlen=16)
        self._lock = threading.Lock()
        self._new_frame = threading.Event()

        # Measured frame rates (updated every 2 s by each capture thread)
        self._fps: list = [0.0, 0.0]

    # ── Public API ────────────────────────────────────────────────────────────

    @property
    def measured_fps(self) -> Tuple[float, float]:
        """Actual frame rates measured over the last 2 s (updated continuously)."""
        return self._fps[0], self._fps[1]

    def start(self) -> None:
        self._cap0 = _make_camera(config.CAM0_IDX, config.WIDTH, config.HEIGHT,
                                  config.FRAMERATE, config.EXPOSURE_VALUE, config.GAIN_VALUE)
        self._cap1 = _make_camera(config.CAM1_IDX, config.WIDTH, config.HEIGHT,
                                  config.FRAMERATE, config.EXPOSURE_VALUE, config.GAIN_VALUE)

        # ── Resolution sanity check ──────────────────────────────────────────
        # cap.get(WIDTH/HEIGHT) returns what we REQUESTED on macOS AVFoundation
        # even when the camera silently negotiates a different mode, so we must
        # actually read a frame to learn the true delivered size. If cam0 and
        # cam1 end up at different sizes, triangulation will be wrong (the
        # calibration K is built for ONE resolution), so refuse to start.
        def _probe(cap, label):
            ok, f = cap.read()
            if not ok or f is None:
                raise RuntimeError(f"{label}: cap.read() returned no frame")
            return f.shape[1], f.shape[0]   # (w, h)

        try:
            w0, h0 = _probe(self._cap0, "cam0")
            w1, h1 = _probe(self._cap1, "cam1")
        except RuntimeError:
            self._cap0.release(); self._cap1.release()
            raise

        if (w0, h0) != (w1, h1):
            self._cap0.release(); self._cap1.release()
            raise RuntimeError(
                f"Camera resolution mismatch: cam0 delivered {w0}×{h0}, "
                f"cam1 delivered {w1}×{h1}. Both must be the same size for "
                f"stereo triangulation to be accurate. Tip: change "
                f"config.WIDTH×HEIGHT to a mode both cameras natively support "
                f"(e.g. 1280×800 @ 120 fps for QILOVE), then recalibrate."
            )
        if (w0, h0) != (config.WIDTH, config.HEIGHT):
            # Cameras agreed but at a different size than config — calibration
            # was done in config.WIDTH×HEIGHT, so the intrinsics are wrong now.
            print(f"[capture] WARNING: cameras deliver {w0}×{h0} but config "
                  f"asked for {config.WIDTH}×{config.HEIGHT}. Recalibrate, or "
                  f"set config.WIDTH/HEIGHT to {w0}/{h0} and recalibrate.")
        else:
            print(f"[capture] Both cameras delivering {w0}×{h0} ✓")

        self._running = True

        threading.Thread(target=self._capture, args=(self._cap0, self._buf0, 0), daemon=True).start()
        threading.Thread(target=self._capture, args=(self._cap1, self._buf1, 1), daemon=True).start()
        threading.Thread(target=self._pair_loop, daemon=True).start()

    def stop(self) -> None:
        self._running = False
        self._new_frame.set()   # unblock pairing thread
        if self._cap0:
            self._cap0.release()
        if self._cap1:
            self._cap1.release()

    # ── Internal threads ──────────────────────────────────────────────────────

    def _capture(self, cap: cv2.VideoCapture, buf: Deque, cam_idx: int) -> None:
        """Per-camera capture loop. Runs in its own thread."""
        t0 = time.monotonic()
        n = 0
        while self._running:
            ok, frame = cap.read()
            if not ok:
                continue
            ts = time.monotonic()
            n += 1
            if ts - t0 >= 2.0:
                self._fps[cam_idx] = n / (ts - t0)
                n = 0
                t0 = ts
            with self._lock:
                buf.append((ts, frame))
            self._new_frame.set()

    def _pair_loop(self) -> None:
        """Match nearest L/R frames. Runs in its own thread."""
        while self._running:
            self._new_frame.wait(timeout=0.1)
            self._new_frame.clear()
            self._try_pair()

    def _try_pair(self) -> None:
        with self._lock:
            if not self._buf0 or not self._buf1:
                return

            ts0, f0 = self._buf0[-1]
            ts1, f1 = self._buf1[-1]

            skew = abs(ts0 - ts1)
            if skew > _MAX_SKEW_S:
                return   # cameras are out of sync — wait for next frames

            # Consume both buffers so we don't emit the same pair twice
            self._buf0.clear()
            self._buf1.clear()

        pair = FramePair(
            left=f0,
            right=f1,
            timestamp=(ts0 + ts1) / 2.0,
        )
        try:
            self._on_pair(pair)
        except Exception:
            pass  # never let a crashing callback kill the pair loop


class SpinCapturer:
    """
    Optional high-speed spin camera (config.SPIN_CAM_*).

    No pairing — every captured frame is passed to on_frame immediately.
    start() returns False instead of raising if the camera can't be opened,
    so a missing add-on camera degrades gracefully to stereo-based spin.

    Usage:
        spin = SpinCapturer(on_frame=my_callback)
        if spin.start():
            ...
            spin.stop()
    """

    def __init__(self, on_frame: SpinFrameCallback) -> None:
        self._on_frame = on_frame
        self._running  = False
        self._cap: Optional[cv2.VideoCapture] = None

    def start(self) -> bool:
        try:
            self._cap = _make_camera(
                config.SPIN_CAM_IDX, config.SPIN_CAM_WIDTH, config.SPIN_CAM_HEIGHT,
                config.SPIN_CAM_FPS, config.SPIN_CAM_EXPOSURE_VALUE, config.SPIN_CAM_GAIN_VALUE,
            )
        except RuntimeError:
            self._cap = None
            return False
        self._running = True
        threading.Thread(target=self._capture, daemon=True).start()
        return True

    def stop(self) -> None:
        self._running = False
        if self._cap:
            self._cap.release()

    def _capture(self) -> None:
        while self._running:
            ok, frame = self._cap.read()
            if not ok:
                continue
            self._on_frame(SpinFrame(frame=frame, timestamp=time.monotonic()))
