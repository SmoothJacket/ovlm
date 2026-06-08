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
    def __init__(self) -> None:
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
            minRadius=config.BALL_MIN_RADIUS_PX,
            maxRadius=config.BALL_MAX_RADIUS_PX,
        )

        if circles is None:
            return None

        # Best candidate (highest accumulator vote = first entry)
        cx, cy, r = circles[0, 0]
        cx += ox
        cy += oy

        confidence = min(1.0, float(r) / config.BALL_MAX_RADIUS_PX)
        return Detection2D(cx=float(cx), cy=float(cy), radius=float(r), confidence=confidence)

    def reset(self) -> None:
        self._mog2 = cv2.createBackgroundSubtractorMOG2(
            history=config.MOG2_HISTORY,
            varThreshold=config.MOG2_THRESHOLD,
            detectShadows=False,
        )
