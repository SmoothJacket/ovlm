"""
Stereo triangulation using the Direct Linear Transform (DLT).

Calibration data is loaded from a .npz file produced by calibrate.py.
Falls back to an approximate analytical formula when no calibration exists.
"""

import os
from dataclasses import dataclass
from typing import Optional, Tuple

import cv2
import numpy as np

import config


@dataclass
class Point3D:
    x: float   # meters, world frame
    y: float
    z: float   # +Z toward pitcher
    timestamp: float


class Triangulator:
    def __init__(self) -> None:
        self._P0: Optional[np.ndarray] = None  # 3×4 projection matrix cam0
        self._P1: Optional[np.ndarray] = None
        self._load_calibration()

    def _load_calibration(self) -> None:
        if not os.path.exists(config.CALIBRATION_FILE):
            return

        data = np.load(config.CALIBRATION_FILE)
        self._P0 = data["P0"]   # shape (3,4)
        self._P1 = data["P1"]
        print(f"[triangulate] Loaded calibration from {config.CALIBRATION_FILE}")

    @property
    def is_calibrated(self) -> bool:
        return self._P0 is not None

    def triangulate(
        self,
        u0: float, v0: float,
        u1: float, v1: float,
        timestamp: float,
    ) -> Point3D:
        if self._P0 is not None and self._P1 is not None:
            return self._dlt(u0, v0, u1, v1, timestamp)
        return self._analytical_fallback(u0, v0, u1, v1, timestamp)

    def _dlt(self, u0: float, v0: float, u1: float, v1: float, ts: float) -> Point3D:
        pts0 = np.array([[u0, v0]], dtype=np.float64)
        pts1 = np.array([[u1, v1]], dtype=np.float64)
        X = cv2.triangulatePoints(self._P0, self._P1, pts0.T, pts1.T)
        X /= X[3]
        return Point3D(x=float(X[0]), y=float(X[1]), z=float(X[2]), timestamp=ts)

    def _analytical_fallback(
        self, u0: float, v0: float, u1: float, v1: float, ts: float
    ) -> Point3D:
        # Simple disparity → depth assuming rectified horizontal stereo
        cx = config.WIDTH / 2.0
        cy = config.HEIGHT / 2.0
        f  = config.FOCAL_LENGTH_PX
        B  = config.BASELINE_M

        disparity = u0 - u1
        if abs(disparity) < 0.5:
            disparity = 0.5  # guard against division by zero

        z = f * B / disparity
        x = (u0 - cx) * z / f
        y = (v0 - cy) * z / f
        return Point3D(x=x, y=y, z=z, timestamp=ts)
