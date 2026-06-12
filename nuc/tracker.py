"""
ROI-predicting ball tracker.

State machine
─────────────
  SEARCHING  → full-frame MOG2 + HoughCircles
              → enters TRACKING after MIN_INIT consecutive detections

  TRACKING   → velocity-predicted ROI (tight)
              → on miss: widen ROI up to two steps before returning to SEARCHING

  (back to SEARCHING after MAX_MISSES consecutive misses)

Velocity is estimated from the last two detections and smoothed with an
exponential moving average so a single noisy detection doesn't throw off
the next prediction.

Gravity bias: the ROI is extended an extra GRAVITY_PAD_PX downward because
the ball accelerates toward the ground. This avoids needing the pixel-per-
metre calibration at detection time.
"""

from collections import deque
from dataclasses import dataclass
from enum import Enum, auto
from typing import Deque, Optional, Tuple

import numpy as np

import config
from detect import BallDetector, Detection2D


class _State(Enum):
    SEARCHING = auto()
    TRACKING  = auto()


@dataclass
class _Entry:
    cx: float
    cy: float
    frame_idx: int


# ── Tuning constants ──────────────────────────────────────────────────────────

# ROI half-width in pixels at each miss level
_ROI_TIGHT   = 40    # px — tracking well
_ROI_WIDE1   = 80    # px — 1 miss
_ROI_WIDE2   = 130   # px — 2 misses

# Extra downward padding for gravity (ball always falls, never rises after contact)
_GRAVITY_PAD = 14    # px

# Consecutive detections before we trust the velocity estimate
_MIN_INIT    = 2

# Consecutive misses before abandoning the track
_MAX_MISSES  = 3

# EMA smoothing factor for velocity (higher = more responsive, noisier)
_VEL_ALPHA   = 0.65

# Outlier gate: reject a detection if it's > this many px from the prediction
_MAX_OUTLIER_DIST = 160.0   # px


class BallTracker:
    """
    Drop-in replacement for BallDetector that adds predictive ROI tracking.

    Usage:
        tracker = BallTracker()
        for frame_idx, frame in enumerate(frames):
            det = tracker.update(frame, frame_idx)
            if det:
                # use det.cx, det.cy, det.radius, det.confidence
        tracker.reset()   # before processing the next swing
    """

    def __init__(self, min_radius: int = None, max_radius: int = None) -> None:
        self._detector  = BallDetector(min_radius=min_radius, max_radius=max_radius)
        self._history:  Deque[_Entry] = deque(maxlen=4)
        self._velocity: Tuple[float, float] = (0.0, 0.0)
        self._miss_count  = 0
        self._init_count  = 0
        self._state       = _State.SEARCHING

        # Stats for this swing window (reset() clears them)
        self.frames_searched  = 0
        self.frames_tracked   = 0
        self.frames_detected  = 0
        self.frames_missed    = 0

    # ── Public API ─────────────────────────────────────────────────────────────

    @property
    def tracking(self) -> bool:
        return self._state is _State.TRACKING

    def update(self, frame_bgr: np.ndarray, frame_idx: int) -> Optional[Detection2D]:
        if self._state is _State.SEARCHING:
            self.frames_searched += 1
            det = self._detector.detect(frame_bgr)
        else:
            self.frames_tracked += 1
            det = self._detect_in_roi(frame_bgr)

        self._update_state(det, frame_idx)

        if det is not None:
            self.frames_detected += 1
        else:
            self.frames_missed += 1

        return det

    def reset(self) -> None:
        self._history.clear()
        self._velocity   = (0.0, 0.0)
        self._miss_count = 0
        self._init_count = 0
        self._state      = _State.SEARCHING
        self._detector.reset()

        self.frames_searched = 0
        self.frames_tracked  = 0
        self.frames_detected = 0
        self.frames_missed   = 0

    # ── ROI detection ──────────────────────────────────────────────────────────

    def _detect_in_roi(self, frame: np.ndarray) -> Optional[Detection2D]:
        h, w = frame.shape[:2]

        for radius in (_ROI_TIGHT, _ROI_WIDE1, _ROI_WIDE2):
            roi = self._build_roi(w, h, radius)
            det = self._detector.detect(frame, roi=roi)
            if det is not None:
                # Outlier gate
                pred_cx, pred_cy = self._predicted_center()
                dist = ((det.cx - pred_cx) ** 2 + (det.cy - pred_cy) ** 2) ** 0.5
                if dist <= _MAX_OUTLIER_DIST:
                    return det
                # Looks like a false positive — keep widening, don't return it
                det = None

        return None   # all ROI widths failed → _update_state will count as miss

    def _build_roi(self, img_w: int, img_h: int, radius: int) -> Tuple[int, int, int, int]:
        cx, cy = self._predicted_center()

        x1 = max(0, int(cx - radius))
        y1 = max(0, int(cy - radius))
        x2 = min(img_w, int(cx + radius))
        y2 = min(img_h, int(cy + radius + _GRAVITY_PAD))

        # Degenerate ROI fallback — shouldn't happen but be safe
        if x2 - x1 < 2 * config.BALL_MIN_RADIUS_PX or y2 - y1 < 2 * config.BALL_MIN_RADIUS_PX:
            return (0, 0, img_w, img_h)

        return (x1, y1, x2 - x1, y2 - y1)

    def _predicted_center(self) -> Tuple[float, float]:
        if not self._history:
            return (0.0, 0.0)
        last = self._history[-1]
        return last.cx + self._velocity[0], last.cy + self._velocity[1]

    # ── State transitions ──────────────────────────────────────────────────────

    def _update_state(self, det: Optional[Detection2D], frame_idx: int) -> None:
        if det is not None:
            self._miss_count = 0

            # Update velocity with EMA smoothing
            if self._history:
                prev = self._history[-1]
                df   = max(1, frame_idx - prev.frame_idx)
                raw_vx = (det.cx - prev.cx) / df
                raw_vy = (det.cy - prev.cy) / df
                self._velocity = (
                    _VEL_ALPHA * raw_vx + (1 - _VEL_ALPHA) * self._velocity[0],
                    _VEL_ALPHA * raw_vy + (1 - _VEL_ALPHA) * self._velocity[1],
                )

            self._history.append(_Entry(cx=det.cx, cy=det.cy, frame_idx=frame_idx))
            self._init_count += 1

            if self._init_count >= _MIN_INIT:
                self._state = _State.TRACKING
        else:
            self._miss_count += 1
            self._init_count  = 0

            if self._miss_count >= _MAX_MISSES:
                self._state      = _State.SEARCHING
                self._history.clear()
                self._velocity   = (0.0, 0.0)
                self._miss_count = 0
