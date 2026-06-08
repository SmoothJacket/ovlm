"""
Stereo frame capture using picamera2.

Each camera runs in its own thread so they capture truly in parallel.
Frames are paired by nearest timestamp — max skew is one frame interval.

Exposure is locked to config values so a fast-moving ball stays sharp.
Auto-exposure and auto-white-balance are both disabled.
"""

import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Callable, Deque, Optional, Tuple

import numpy as np

import config

try:
    from picamera2 import Picamera2
    PICAMERA2_AVAILABLE = True
except ImportError:
    PICAMERA2_AVAILABLE = False


@dataclass
class FramePair:
    left: np.ndarray    # (H, W, 3) BGR
    right: np.ndarray
    timestamp: float    # seconds, monotonic


FramePairCallback = Callable[[FramePair], None]

# One frame interval — maximum allowed timestamp skew between L and R frames
_MAX_SKEW_S = 1.0 / config.FRAMERATE


def _make_camera(idx: int) -> "Picamera2":
    cam = Picamera2(idx)
    cfg = cam.create_video_configuration(
        main={"format": "BGR888", "size": (config.WIDTH, config.HEIGHT)},
    )
    cam.configure(cfg)

    # Lock exposure before the first frame so there's no auto-exposure warmup
    cam.set_controls({
        "AeEnable":     config.AE_ENABLE,
        "AwbEnable":    config.AWB_ENABLE,
        "ExposureTime": config.EXPOSURE_TIME_US,
        "AnalogueGain": config.ANALOGUE_GAIN,
        "ColourGains":  config.COLOUR_GAINS,
        "FrameRate":    float(config.FRAMERATE),
    })
    return cam


class StereoCapturer:
    """
    Captures synchronised frame pairs from two picamera2 cameras.

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
        self._cam0: Optional["Picamera2"] = None
        self._cam1: Optional["Picamera2"] = None

        # Ring buffers — each camera thread writes here
        self._buf0: Deque[Tuple[float, np.ndarray]] = deque(maxlen=16)
        self._buf1: Deque[Tuple[float, np.ndarray]] = deque(maxlen=16)
        self._lock = threading.Lock()
        self._new_frame = threading.Event()

    # ── Public API ────────────────────────────────────────────────────────────

    def start(self) -> None:
        if not PICAMERA2_AVAILABLE:
            raise RuntimeError("picamera2 is not installed. Run: pip install picamera2")

        self._cam0 = _make_camera(config.CAM0_IDX)
        self._cam1 = _make_camera(config.CAM1_IDX)

        self._running = True

        # Start cameras as close together as possible
        self._cam0.start()
        self._cam1.start()

        threading.Thread(target=self._capture, args=(self._cam0, self._buf0), daemon=True).start()
        threading.Thread(target=self._capture, args=(self._cam1, self._buf1), daemon=True).start()
        threading.Thread(target=self._pair_loop, daemon=True).start()

    def stop(self) -> None:
        self._running = False
        self._new_frame.set()   # unblock pairing thread
        if self._cam0:
            self._cam0.stop()
        if self._cam1:
            self._cam1.stop()

    # ── Internal threads ──────────────────────────────────────────────────────

    def _capture(self, cam: "Picamera2", buf: Deque) -> None:
        """Per-camera capture loop. Runs in its own thread."""
        while self._running:
            frame = cam.capture_array("main")
            ts = time.monotonic()
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
        self._on_pair(pair)
