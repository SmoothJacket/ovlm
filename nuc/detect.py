"""
2D ball detection in a single camera frame.

Strategy:
  1. Grayscale + MOG2 background subtraction → motion mask
  2. Gaussian blur → HoughCircles
  3. Sub-pixel centroid refinement
"""

from dataclasses import dataclass
from typing import Optional, Tuple

import cv2
import numpy as np

import config


@dataclass
class Detection2D:
    cx: float
    cy: float
    radius: float
    confidence: float   # 0–1


class BallDetector:
    def __init__(self, min_radius: int = None, max_radius: int = None) -> None:
        # Radius bounds default to the stereo cameras'; the zoomed spin camera
        # passes its own much larger range.
        self._min_radius = min_radius if min_radius is not None else config.BALL_MIN_RADIUS_PX
        self._max_radius = max_radius if max_radius is not None else config.BALL_MAX_RADIUS_PX
        self._mog2 = cv2.createBackgroundSubtractorMOG2(
            history=config.MOG2_HISTORY,
            varThreshold=config.MOG2_THRESHOLD,
            detectShadows=False,
        )

    def detect(
        self,
        frame_bgr: np.ndarray,
        roi: Optional[Tuple[int, int, int, int]] = None,
    ) -> Optional[Detection2D]:
        gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
        fg = self._mog2.apply(gray)

        if roi is not None:
            x, y, w, h = roi
            work = fg[y : y + h, x : x + w]
            ox, oy = x, y
        else:
            work = fg
            ox, oy = 0, 0

        blurred = cv2.GaussianBlur(work, (5, 5), 1.5)

        circles = cv2.HoughCircles(
            blurred,
            cv2.HOUGH_GRADIENT,
            dp=1,
            minDist=20,   # was 30; ball at long range is small, allow closer candidates
            param1=40,    # was 50; lower Canny threshold catches faint edges at distance
            param2=12,    # was 20; lower accumulator threshold detects 2–4 px circles
            minRadius=self._min_radius,
            maxRadius=self._max_radius,
        )

        if circles is None:
            return None

        # Best candidate (highest accumulator vote = first entry)
        cx, cy, r = circles[0, 0]

        # ── Sub-pixel refinement ─────────────────────────────────────────────
        # HoughCircles only resolves the centre to the accumulator-grid step
        # (≈1 px at dp=1). Re-centre on the brightness-weighted centroid of
        # the foreground pixels inside the detected disk for true sub-pixel
        # precision — typically tightens the centre by 0.2–0.5 px, which cuts
        # triangulation noise (and downstream EV/LA/spray jitter) by roughly
        # the same factor. `cx,cy` are in the SAME coord system as `work`
        # (post-ROI crop) — apply (ox, oy) to lift to full-frame AFTER.
        r_int = max(2, int(round(r)))
        x0, y0 = int(cx) - r_int, int(cy) - r_int
        x1, y1 = int(cx) + r_int + 1, int(cy) + r_int + 1
        H, W = work.shape[:2]
        x0c, y0c = max(0, x0), max(0, y0)
        x1c, y1c = min(W, x1), min(H, y1)
        if x1c > x0c and y1c > y0c:
            patch = work[y0c:y1c, x0c:x1c].astype(np.float32)
            total = float(patch.sum())
            if total > 0:
                ys, xs = np.indices(patch.shape, dtype=np.float32)
                cx_ref = float((patch * xs).sum() / total) + x0c
                cy_ref = float((patch * ys).sum() / total) + y0c
                # Only accept refinement if it stays within the detected disk.
                if (cx_ref - cx) ** 2 + (cy_ref - cy) ** 2 <= r * r:
                    cx, cy = cx_ref, cy_ref

        cx += ox
        cy += oy

        confidence = min(1.0, float(r) / self._max_radius)
        return Detection2D(cx=float(cx), cy=float(cy), radius=float(r), confidence=confidence)

    def reset(self) -> None:
        # Radius bounds are kept — only the background model is rebuilt
        self._mog2 = cv2.createBackgroundSubtractorMOG2(
            history=config.MOG2_HISTORY,
            varThreshold=config.MOG2_THRESHOLD,
            detectShadows=False,
        )
