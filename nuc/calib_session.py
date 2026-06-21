"""
Headless calibration session — drives home-plate stereo calibration over WebSocket.

Used by server.py / main.py to stream annotated preview frames to the browser
and run the corner-averaging + PnP solve when the user clicks Capture.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Optional, Tuple

import cv2
import numpy as np

import config
from plate_calib import (
    plate_object_points,
    canonical_order,
    solve_pose,
    build_K,
    calibrate,
    OBJP,
)
from plate_detector import detect_plate_corners

log = logging.getLogger(__name__)

PREVIEW_W = 640
PREVIEW_H = 480


@dataclass
class CalibResult:
    ok: bool
    reprojPx: float
    residualMm: float
    baselineMm: float
    message: str


class CalibSession:
    """
    Manages one calibration attempt:
    - streams ~15 fps annotated JPEG previews via grab_annotated()
    - accumulates corner samples and solves stereo pose on capture()
    """

    def __init__(self, height_mm: float, dist_mm: float,
                 cap0: int = config.CAM0_IDX, cap1: int = config.CAM1_IDX) -> None:
        self.height_mm = height_mm
        self.dist_mm   = dist_mm
        self.step      = 'align'   # 'align' | 'capturing' | 'done'
        self._lock     = threading.Lock()

        self._cap0 = self._open(cap0)
        self._cap1 = self._open(cap1)

        if not self._cap0.isOpened() or not self._cap1.isOpened():
            log.warning("CalibSession: one or both cameras failed to open")

    # ── Public API ────────────────────────────────────────────────────────────

    def grab_annotated(self) -> Tuple[bytes, bytes, bool, bool]:
        """Read one frame pair, draw corner overlays, return JPEG bytes."""
        ok0, f0 = self._cap0.read()
        ok1, f1 = self._cap1.read()

        if not ok0 or f0 is None:
            f0 = np.zeros((PREVIEW_H, PREVIEW_W, 3), dtype=np.uint8)
            cv2.putText(f0, "CAM0 not available", (10, PREVIEW_H // 2),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 180), 2)
        if not ok1 or f1 is None:
            f1 = np.zeros((PREVIEW_H, PREVIEW_W, 3), dtype=np.uint8)
            cv2.putText(f1, "CAM1 not available", (10, PREVIEW_H // 2),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 180), 2)

        corners0 = canonical_order(detect_plate_corners(f0))
        corners1 = canonical_order(detect_plate_corners(f1))

        j0 = self._annotate_jpeg(f0, corners0, "CAM 0")
        j1 = self._annotate_jpeg(f1, corners1, "CAM 1")

        return j0, j1, (corners0 is not None), (corners1 is not None)

    def capture(self) -> CalibResult:
        """Average PLATE_CALIB_FRAMES detections then solve stereo pose.
        Saves calibration.npz on success. Blocks — run in a thread pool."""
        self.step = 'capturing'
        frames = config.PLATE_CALIB_FRAMES

        acc0: list[np.ndarray] = []
        acc1: list[np.ndarray] = []
        img_size = (config.WIDTH, config.HEIGHT)

        log.info("CalibSession: collecting %d frames …", frames)
        while len(acc0) < frames:
            ok0, f0 = self._cap0.read()
            ok1, f1 = self._cap1.read()
            if not ok0 or not ok1 or f0 is None or f1 is None:
                continue
            c0 = canonical_order(detect_plate_corners(f0))
            c1 = canonical_order(detect_plate_corners(f1))
            if c0 is not None and c1 is not None:
                acc0.append(c0)
                acc1.append(c1)
                if len(acc0) % 5 == 0:
                    log.info("CalibSession: %d/%d frames collected", len(acc0), frames)

        if len(acc0) < max(5, frames // 4):
            self.step = 'align'
            return CalibResult(
                ok=False, reprojPx=0, residualMm=0, baselineMm=0,
                message=f"Only {len(acc0)} good detections — plate not reliably seen in both cameras.",
            )

        mean0 = np.mean(acc0, axis=0)
        mean1 = np.mean(acc1, axis=0)

        ok = calibrate(mean0, mean1, img_size, config.CALIBRATION_FILE, refine_focal=False)
        self.step = 'done'

        if not ok:
            return CalibResult(
                ok=False, reprojPx=0, residualMm=0, baselineMm=0,
                message="PnP failed — make sure the plate fills both frames and is evenly lit.",
            )

        data = np.load(config.CALIBRATION_FILE)
        reproj_px    = float(data.get("reproj_px",           0))
        residual_mm  = float(data.get("triangulation_rms_mm", 0))
        baseline_mm  = float(data.get("baseline_mm",          0))

        grade = ("Excellent" if residual_mm < 5  and reproj_px < 1.5 else
                 "Good"      if residual_mm < 15 and reproj_px < 3.0 else
                 "Rough — try moving the plate larger in frame")

        return CalibResult(
            ok=True,
            reprojPx=round(reproj_px, 2),
            residualMm=round(residual_mm, 1),
            baselineMm=round(baseline_mm, 1),
            message=f"{grade} | reproj {reproj_px:.1f} px, baseline {baseline_mm:.0f} mm, RMS {residual_mm:.1f} mm",
        )

    def release(self) -> None:
        self._cap0.release()
        self._cap1.release()

    # ── Internals ─────────────────────────────────────────────────────────────

    @staticmethod
    def _open(idx: int) -> cv2.VideoCapture:
        cap = cv2.VideoCapture(idx, config.CAMERA_BACKEND)
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*config.CAMERA_FOURCC))
        cap.set(cv2.CAP_PROP_FRAME_WIDTH,  config.WIDTH)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, config.HEIGHT)
        cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25)
        cap.set(cv2.CAP_PROP_EXPOSURE, float(config.EXPOSURE_VALUE))
        return cap

    @staticmethod
    def _annotate_jpeg(frame: np.ndarray, corners: Optional[np.ndarray], label: str) -> bytes:
        d = frame.copy()
        h, w = d.shape[:2]

        # Resize to preview resolution
        if (w, h) != (PREVIEW_W, PREVIEW_H):
            sx, sy = PREVIEW_W / w, PREVIEW_H / h
            d = cv2.resize(d, (PREVIEW_W, PREVIEW_H))
            if corners is not None:
                corners = corners * np.array([sx, sy])

        if corners is not None:
            for i, p in enumerate(corners):
                cv2.circle(d, (int(p[0]), int(p[1])), 6, (0, 220, 60), -1)
                cv2.putText(d, str(i), (int(p[0]) + 7, int(p[1]) - 5),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 220, 60), 1)
            cv2.polylines(d, [corners.astype(np.int32)], True, (0, 200, 50), 2)
            status_col = (0, 220, 60)
            status_txt = "PLATE DETECTED"
        else:
            cv2.putText(d, "SEARCHING…", (8, 28),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 60, 220), 2)
            status_col = (0, 60, 220)
            status_txt = "NO PLATE"

        cv2.putText(d, label, (8, PREVIEW_H - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (180, 180, 180), 1)
        cv2.putText(d, status_txt, (PREVIEW_W - 160, 24),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, status_col, 2)

        _, buf = cv2.imencode(".jpg", d, [cv2.IMWRITE_JPEG_QUALITY, 72])
        return bytes(buf)
