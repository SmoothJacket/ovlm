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
            minDist=30,
            param1=50,
            param2=20,
            minRadius=self._min_radius,
            maxRadius=self._max_radius,
        )

        if circles is None:
            return None

        # Best candidate (highest accumulator vote = first entry)
        cx, cy, r = circles[0, 0]
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
