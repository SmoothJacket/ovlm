"""
Stereo calibration using a ChArUco board.

Modes
-----
  Live capture (recommended):
      python calibrate.py --live [--count 25] [--out calibration.npz]

  Batch from saved images:
      python calibrate.py --images ./calib_images [--out calibration.npz]

  Verify an existing calibration:
      python calibrate.py --verify [--cal calibration.npz]

Live capture controls
---------------------
  SPACE  — capture current frame pair (only accepted when board is
            detected in both cameras AND board is stable)
  A      — toggle auto-capture (grabs automatically when stable + new coverage)
  ESC    — stop capturing and run calibration with what we have

Tips for a good calibration
----------------------------
  • Use a printed ChArUco board (print calibrate.py --print-board to make one)
  • Cover all corners and edges of both camera views
  • Tilt the board at different angles (±30°) — flat-on poses give poor results
  • Keep the board still when capturing (stability indicator must be green)
  • Aim for reprojection error < 0.5 px (< 1.0 px is acceptable)
"""

import argparse
import sys
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

import cv2
import numpy as np

import config

# ── ChArUco board parameters ──────────────────────────────────────────────────
SQUARES_X    = 7
SQUARES_Y    = 5
SQUARE_M     = 0.04    # 4 cm
MARKER_M     = 0.03    # 3 cm
ARUCO_DICT   = cv2.aruco.DICT_4X4_50
MIN_CORNERS  = 6       # minimum shared corners to accept a pose
MIN_PAIRS    = 8       # minimum accepted pairs before calibration runs
TARGET_PAIRS = 25      # default --count


# ── Board + detector factory ──────────────────────────────────────────────────

def _make_board():
    d = cv2.aruco.getPredefinedDictionary(ARUCO_DICT)
    b = cv2.aruco.CharucoBoard((SQUARES_X, SQUARES_Y), SQUARE_M, MARKER_M, d)
    return b, d


def _detect(gray: np.ndarray, board, aruco_dict) -> Tuple[Optional[np.ndarray], Optional[np.ndarray]]:
    """Return (charuco_corners, charuco_ids) or (None, None)."""
    params   = cv2.aruco.DetectorParameters()
    detector = cv2.aruco.ArucoDetector(aruco_dict, params)
    corners, ids, _ = detector.detectMarkers(gray)
    if ids is None or len(ids) < 4:
        return None, None

    ch_det  = cv2.aruco.CharucoDetector(board)
    ch_c, ch_id, _, _ = ch_det.detectBoard(gray, corners, ids)
    if ch_id is None or len(ch_id) < MIN_CORNERS:
        return None, None

    return ch_c, ch_id


def _filter_common(
    cl: np.ndarray, idl: np.ndarray,
    cr: np.ndarray, idr: np.ndarray,
) -> Tuple[Optional[np.ndarray], Optional[np.ndarray], Optional[Set[int]]]:
    """Keep only corners visible in both cameras. Returns filtered l/r corners + id set."""
    common = set(idl.flatten()) & set(idr.flatten())
    if len(common) < MIN_CORNERS:
        return None, None, None

    def keep(c, ids, ids_to_keep):
        mask = np.isin(ids.flatten(), list(ids_to_keep))
        return c[mask]

    return keep(cl, idl, common), keep(cr, idr, common), common


# ── Coverage tracking ─────────────────────────────────────────────────────────

class CoverageTracker:
    """
    Divides the image into a grid and marks cells covered by captured detections.
    Helps the user cover the full field of view.
    """

    def __init__(self, img_w: int, img_h: int, grid: int = 4) -> None:
        self._grid = grid
        self._w, self._h = img_w, img_h
        self._covered: np.ndarray = np.zeros((grid, grid), dtype=bool)

    def update(self, corners: np.ndarray) -> None:
        for pt in corners.reshape(-1, 2):
            col = int(pt[0] / self._w * self._grid)
            row = int(pt[1] / self._h * self._grid)
            col = min(col, self._grid - 1)
            row = min(row, self._grid - 1)
            self._covered[row, col] = True

    def coverage_pct(self) -> float:
        return float(self._covered.sum()) / self._covered.size

    def draw(self, img: np.ndarray) -> None:
        cw = self._w // self._grid
        ch = self._h // self._grid
        for r in range(self._grid):
            for c in range(self._grid):
                color = (0, 180, 0) if self._covered[r, c] else (40, 40, 40)
                cv2.rectangle(
                    img,
                    (c * cw, r * ch),
                    ((c + 1) * cw - 1, (r + 1) * ch - 1),
                    color, 1,
                )

    def needs_cell(self, corners: np.ndarray) -> bool:
        """True if this pose covers at least one uncovered grid cell."""
        for pt in corners.reshape(-1, 2):
            col = int(pt[0] / self._w * self._grid)
            row = int(pt[1] / self._h * self._grid)
            col = min(col, self._grid - 1)
            row = min(row, self._grid - 1)
            if not self._covered[row, col]:
                return True
        return False


# ── Stability gate ────────────────────────────────────────────────────────────

class StabilityGate:
    """
    Accepts a pose only if the detected corners haven't moved more than
    MAX_SHIFT pixels between two consecutive frames.
    """

    MAX_SHIFT_PX = 3.0

    def __init__(self) -> None:
        self._prev: Optional[np.ndarray] = None

    def is_stable(self, corners: Optional[np.ndarray]) -> bool:
        if corners is None:
            self._prev = None
            return False
        if self._prev is None or self._prev.shape != corners.shape:
            self._prev = corners
            return False
        shift = float(np.linalg.norm(corners - self._prev))
        self._prev = corners
        return shift < self.MAX_SHIFT_PX


# ── Calibration computation ───────────────────────────────────────────────────

def _run_calibration(
    obj_pts_all: List[np.ndarray],
    img_pts_l: List[np.ndarray],
    img_pts_r: List[np.ndarray],
    img_size: Tuple[int, int],
    out_path: str,
) -> float:
    """Run stereo calibration. Returns overall RMS reprojection error in pixels."""
    print(f"\nRunning stereo calibration on {len(obj_pts_all)} pose pairs …")

    rms0, K0, D0, rvecs0, tvecs0 = cv2.calibrateCamera(
        obj_pts_all, img_pts_l, img_size, None, None
    )
    rms1, K1, D1, rvecs1, tvecs1 = cv2.calibrateCamera(
        obj_pts_all, img_pts_r, img_size, None, None
    )
    print(f"  Left  intrinsic RMS: {rms0:.4f} px")
    print(f"  Right intrinsic RMS: {rms1:.4f} px")

    stereo_flags = cv2.CALIB_FIX_INTRINSIC
    rms_stereo, _, _, _, _, R, T, E, F = cv2.stereoCalibrate(
        obj_pts_all, img_pts_l, img_pts_r,
        K0, D0, K1, D1, img_size,
        flags=stereo_flags,
    )
    print(f"  Stereo RMS:          {rms_stereo:.4f} px")

    baseline_mm = float(np.linalg.norm(T)) * 1000.0
    print(f"  Baseline:            {baseline_mm:.1f} mm")

    R0, R1, P0, P1, Q, roi0, roi1 = cv2.stereoRectify(
        K0, D0, K1, D1, img_size, R, T,
        flags=cv2.CALIB_ZERO_DISPARITY, alpha=0,
    )

    np.savez(
        out_path,
        K0=K0, D0=D0, K1=K1, D1=D1,
        R=R,   T=T,   E=E,   F=F,
        R0=R0, R1=R1, P0=P0, P1=P1, Q=Q,
        roi0=np.array(roi0), roi1=np.array(roi1),
        img_size=np.array(img_size),
        rms=np.float64(rms_stereo),
        baseline_mm=np.float64(baseline_mm),
    )
    print(f"\nSaved → {out_path}")

    if rms_stereo < 0.5:
        grade = "Excellent"
    elif rms_stereo < 1.0:
        grade = "Good"
    elif rms_stereo < 2.0:
        grade = "Acceptable (consider recalibrating)"
    else:
        grade = "Poor — please recalibrate"
    print(f"  Quality: {grade}")

    return rms_stereo


# ── Rectification verification preview ───────────────────────────────────────

def _show_rectification(cal_path: str) -> None:
    """
    Load calibration and show a live rectified preview with horizontal
    epipolar lines so you can verify the cameras are properly aligned.
    """
    data = np.load(cal_path)
    K0, D0 = data["K0"], data["D0"]
    K1, D1 = data["K1"], data["D1"]
    R0, R1 = data["R0"], data["R1"]
    P0, P1 = data["P0"], data["P1"]
    img_size = tuple(data["img_size"].astype(int))
    rms = float(data["rms"])

    map0x, map0y = cv2.initUndistortRectifyMap(K0, D0, R0, P0, img_size, cv2.CV_32FC1)
    map1x, map1y = cv2.initUndistortRectifyMap(K1, D1, R1, P1, img_size, cv2.CV_32FC1)

    cap0 = cv2.VideoCapture(config.CAM0_IDX, config.CAMERA_BACKEND)
    cap1 = cv2.VideoCapture(config.CAM1_IDX, config.CAMERA_BACKEND)
    for cap in (cap0, cap1):
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*config.CAMERA_FOURCC))
        cap.set(cv2.CAP_PROP_FRAME_WIDTH,  img_size[0])
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, img_size[1])

    print(f"Calibration RMS: {rms:.4f} px")
    print("Showing rectified view. Horizontal lines should pass through matching features.")
    print("Press ESC to exit.")

    while True:
        ok0, fl = cap0.read()
        ok1, fr = cap1.read()
        if not ok0 or not ok1:
            continue

        rl = cv2.remap(fl, map0x, map0y, cv2.INTER_LINEAR)
        rr = cv2.remap(fr, map1x, map1y, cv2.INTER_LINEAR)

        combined = np.hstack([rl, rr])
        h = combined.shape[0]
        for y in range(0, h, h // 10):
            cv2.line(combined, (0, y), (combined.shape[1], y), (0, 255, 0), 1)

        label = f"Rectified  |  RMS={rms:.3f}px  |  ESC=quit"
        cv2.putText(combined, label, (10, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 200, 200), 1)
        cv2.imshow("Rectification Verify", combined)

        if cv2.waitKey(1) & 0xFF == 27:
            break

    cv2.destroyAllWindows()
    cap0.release()
    cap1.release()


# ── Live capture session ──────────────────────────────────────────────────────

def calibrate_live(target: int, out_path: str) -> None:
    board, aruco_dict = _make_board()

    img_size = (config.WIDTH, config.HEIGHT)
    cap0 = cv2.VideoCapture(config.CAM0_IDX, config.CAMERA_BACKEND)
    cap1 = cv2.VideoCapture(config.CAM1_IDX, config.CAMERA_BACKEND)
    for cap in (cap0, cap1):
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*config.CAMERA_FOURCC))
        cap.set(cv2.CAP_PROP_FRAME_WIDTH,  img_size[0])
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, img_size[1])
        cap.set(cv2.CAP_PROP_FPS,          float(config.FRAMERATE))
        cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25)
        cap.set(cv2.CAP_PROP_EXPOSURE, float(config.EXPOSURE_VALUE))
    if not cap0.isOpened() or not cap1.isOpened():
        print("Cannot open one or both cameras. Run camera_check.py to diagnose.")
        sys.exit(1)

    save_dir = Path("calib_images")
    save_dir.mkdir(exist_ok=True)

    obj_pts_all: List[np.ndarray] = []
    img_pts_l:   List[np.ndarray] = []
    img_pts_r:   List[np.ndarray] = []

    coverage = CoverageTracker(config.WIDTH, config.HEIGHT)
    stability_l = StabilityGate()
    stability_r = StabilityGate()
    auto_capture = False
    captured = 0

    print(f"Target: {target} pairs  |  SPACE=capture  A=auto  ESC=done")

    while True:
        ok0, fl = cap0.read()
        ok1, fr = cap1.read()
        if not ok0 or not ok1:
            continue

        gl = cv2.cvtColor(fl, cv2.COLOR_BGR2GRAY)
        gr = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)

        cl, idl = _detect(gl, board, aruco_dict)
        cr, idr = _detect(gr, board, aruco_dict)

        board_ok = cl is not None and cr is not None

        cl_f = cr_f = None
        common: Optional[Set[int]] = None
        if board_ok:
            cl_f, cr_f, common = _filter_common(cl, idl, cr, idr)
            board_ok = common is not None

        stable = (
            board_ok
            and stability_l.is_stable(cl_f)
            and stability_r.is_stable(cr_f)
        )

        # ── Build display frames ──────────────────────────────────────────────
        disp_l = fl.copy()
        disp_r = fr.copy()

        if board_ok and cl_f is not None:
            cv2.drawChessboardCorners(disp_l, (SQUARES_X - 1, SQUARES_Y - 1),
                                      cl_f, True)
        if board_ok and cr_f is not None:
            cv2.drawChessboardCorners(disp_r, (SQUARES_X - 1, SQUARES_Y - 1),
                                      cr_f, True)

        coverage.draw(disp_l)

        # Status bar
        status_color = (0, 220, 0) if stable else ((0, 200, 200) if board_ok else (0, 0, 200))
        status_text  = (
            "STABLE — ready" if stable else
            ("BOARD FOUND — hold still" if board_ok else "No board detected")
        )
        auto_text = "  [AUTO ON]" if auto_capture else ""
        line1 = f"{captured}/{target}  {status_text}{auto_text}"
        line2 = f"Coverage: {coverage.coverage_pct()*100:.0f}%  |  SPACE=capture  A=auto  ESC=done"

        for disp in (disp_l, disp_r):
            cv2.rectangle(disp, (0, 0), (config.WIDTH, 50), (20, 20, 20), -1)
            cv2.putText(disp, line1, (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.55, status_color, 1)
            cv2.putText(disp, line2, (8, 42), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (160, 160, 160), 1)

        preview = np.hstack([disp_l, disp_r])
        cv2.imshow("OVLM Stereo Calibration", preview)

        # ── Auto-capture logic ────────────────────────────────────────────────
        do_capture = False
        key = cv2.waitKey(1) & 0xFF
        if key == 27:
            break
        elif key == ord(' ') and stable:
            do_capture = True
        elif key == ord('a'):
            auto_capture = not auto_capture
            print(f"Auto-capture {'ON' if auto_capture else 'OFF'}")

        if auto_capture and stable and cl_f is not None and coverage.needs_cell(cl_f):
            do_capture = True

        if do_capture and board_ok and cl_f is not None and cr_f is not None and common is not None:
            # Build object points from board corner 3D positions
            board_corners_3d = board.getChessboardCorners()
            ids_list = sorted(common)
            obj_pts = np.array(
                [board_corners_3d[i] for i in ids_list], dtype=np.float32
            )
            obj_pts = np.hstack([obj_pts, np.zeros((len(obj_pts), 1), dtype=np.float32)])

            # Re-order filtered corners to match sorted IDs
            idl_flat = idl.flatten()
            idr_flat = idr.flatten()
            cl_sorted = np.array([cl[np.where(idl_flat == i)[0][0]] for i in ids_list])
            cr_sorted = np.array([cr[np.where(idr_flat == i)[0][0]] for i in ids_list])

            obj_pts_all.append(obj_pts)
            img_pts_l.append(cl_sorted.reshape(-1, 1, 2).astype(np.float32))
            img_pts_r.append(cr_sorted.reshape(-1, 1, 2).astype(np.float32))
            coverage.update(cl_f)

            idx = f"{captured:03d}"
            cv2.imwrite(str(save_dir / f"left_{idx}.jpg"),  fl)
            cv2.imwrite(str(save_dir / f"right_{idx}.jpg"), fr)
            captured += 1
            print(f"  [{captured}/{target}]  corners={len(common)}  coverage={coverage.coverage_pct()*100:.0f}%")

            if captured >= target:
                break

    cv2.destroyAllWindows()
    cap0.release()
    cap1.release()

    if len(obj_pts_all) < MIN_PAIRS:
        print(f"Only {len(obj_pts_all)} pairs captured (need {MIN_PAIRS}). Aborting.")
        sys.exit(1)

    rms = _run_calibration(obj_pts_all, img_pts_l, img_pts_r, img_size, out_path)

    if rms < 2.0:
        print("\nShowing rectification preview … (ESC to exit)")
        _show_rectification(out_path)


# ── Batch calibration from saved images ──────────────────────────────────────

def calibrate_from_images(image_dir: str, out_path: str) -> None:
    board, aruco_dict = _make_board()
    d = Path(image_dir)

    lefts  = sorted(d.glob("left_*.jpg"))  + sorted(d.glob("left_*.png"))
    rights = sorted(d.glob("right_*.jpg")) + sorted(d.glob("right_*.png"))

    if len(lefts) == 0 or len(lefts) != len(rights):
        print(f"ERROR: found {len(lefts)} left / {len(rights)} right images in {d}")
        sys.exit(1)

    obj_pts_all: List[np.ndarray] = []
    img_pts_l:   List[np.ndarray] = []
    img_pts_r:   List[np.ndarray] = []
    img_size = None

    for lp, rp in zip(lefts, rights):
        il = cv2.imread(str(lp), cv2.IMREAD_GRAYSCALE)
        ir = cv2.imread(str(rp), cv2.IMREAD_GRAYSCALE)
        if il is None or ir is None:
            print(f"  skip (unreadable): {lp.name}")
            continue
        img_size = (il.shape[1], il.shape[0])

        cl, idl = _detect(il, board, aruco_dict)
        cr, idr = _detect(ir, board, aruco_dict)
        if cl is None or cr is None:
            print(f"  skip (no board):   {lp.name}")
            continue

        cl_f, cr_f, common = _filter_common(cl, idl, cr, idr)
        if common is None:
            print(f"  skip (few common): {lp.name}")
            continue

        ids_list = sorted(common)
        board_corners_3d = board.getChessboardCorners()
        obj_pts = np.array([board_corners_3d[i] for i in ids_list], dtype=np.float32)
        obj_pts = np.hstack([obj_pts, np.zeros((len(obj_pts), 1), dtype=np.float32)])

        idl_flat = idl.flatten()
        idr_flat = idr.flatten()
        cl_sorted = np.array([cl[np.where(idl_flat == i)[0][0]] for i in ids_list])
        cr_sorted = np.array([cr[np.where(idr_flat == i)[0][0]] for i in ids_list])

        obj_pts_all.append(obj_pts)
        img_pts_l.append(cl_sorted.reshape(-1, 1, 2).astype(np.float32))
        img_pts_r.append(cr_sorted.reshape(-1, 1, 2).astype(np.float32))
        print(f"  ok: {lp.name}  ({len(common)} corners)")

    if len(obj_pts_all) < MIN_PAIRS:
        print(f"Only {len(obj_pts_all)} usable pairs (need {MIN_PAIRS}). Aborting.")
        sys.exit(1)

    _run_calibration(obj_pts_all, img_pts_l, img_pts_r, img_size, out_path)


# ── Print board utility ───────────────────────────────────────────────────────

def print_board() -> None:
    board, _ = _make_board()
    img = board.generateImage((SQUARES_X * 100, SQUARES_Y * 100), marginSize=20)
    path = "charuco_board.png"
    cv2.imwrite(path, img)
    print(f"Board image saved to {path}")
    print(f"Print at exactly {SQUARES_X * SQUARE_M * 100:.0f}cm × {SQUARES_Y * SQUARE_M * 100:.0f}cm")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="OVLM stereo calibration")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--live",        action="store_true", help="Live capture from cameras")
    mode.add_argument("--images",      metavar="DIR",       help="Batch calibrate from image folder")
    mode.add_argument("--verify",      action="store_true", help="Show rectified live preview")
    mode.add_argument("--print-board", action="store_true", help="Save ChArUco board image")

    parser.add_argument("--count", type=int, default=TARGET_PAIRS, help="Target capture count (live mode)")
    parser.add_argument("--out",   default=config.CALIBRATION_FILE,  help="Output .npz path")
    parser.add_argument("--cal",   default=config.CALIBRATION_FILE,  help="Calibration file (verify mode)")
    args = parser.parse_args()

    if args.print_board:
        print_board()
    elif args.live:
        calibrate_live(args.count, args.out)
    elif args.images:
        calibrate_from_images(args.images, args.out)
    elif args.verify:
        _show_rectification(args.cal)
    else:
        parser.print_help()
