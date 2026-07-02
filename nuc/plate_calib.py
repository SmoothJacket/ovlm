"""
Home-plate stereo calibration — no ChArUco board required.

A regulation home plate is a pentagon with exactly known dimensions, so its five
corners are a metric calibration target. plate_detector.py (the AI keypoint
model, with a classical fallback) locates the corners in both cameras; this
module solves each camera's pose by PnP against the plate's known 3-D geometry,
which yields the stereo extrinsics — baseline and relative rotation — in true
metric scale from a SINGLE shared view of the plate.

World frame (matches the rest of OVLM):
    origin = centre of home plate, on the ground
    +Z toward the pitcher, +Y up, +X toward the first-base side

Intrinsics (focal length, principal point) come from the lens + sensor spec in
config, because one planar view can't recover them robustly. Focal length can
optionally be refined from the plate homography (--refine-focal).

Usage:
    python plate_calib.py --live                 # capture from both cameras
    python plate_calib.py --live --refine-focal  # also estimate focal length
    python plate_calib.py --pair L.png R.png      # solve from a saved image pair
    python plate_calib.py --verify                # rectified epipolar preview

The output calibration.npz is drop-in compatible with triangulate.py: P0/P1 are
the unrectified world→image projection matrices triangulate() feeds raw pixels.
"""

from __future__ import annotations

import argparse
import sys
import threading
from typing import Optional, Tuple

import cv2
import numpy as np

import config
from plate_detector import detect_plate_corners, using_learned_model

_PREVIEW_W = 640
_PREVIEW_H = 480

IN_TO_M = 0.0254


# ── Plate geometry (world coordinates, metres) ────────────────────────────────

def plate_object_points() -> np.ndarray:
    """5 plate corners in the world frame, order [FL, FR, MR, BP, ML].
    Origin at the plate centroid on the ground (Y=0), +Z toward the pitcher."""
    half  = config.PLATE_FRONT_IN / 2.0          # 8.5"
    side  = config.PLATE_SIDE_IN                  # 8.5"
    back  = config.PLATE_BACK_IN                  # 8.47"
    # Front edge at Z=0, plate extends back to −Z; then shift so centroid = origin.
    fl = (-half, 0.0,  0.0)
    fr = ( half, 0.0,  0.0)
    ml = (-half, 0.0, -side)
    mr = ( half, 0.0, -side)
    bp = ( 0.0,  0.0, -(side + back))
    pts = np.array([fl, fr, mr, bp, ml], dtype=np.float64)
    # Area-weighted centroid Z (rectangle + triangle) → move origin there
    rect_a, rect_z = config.PLATE_FRONT_IN * side, -side / 2.0
    tri_a,  tri_z  = 0.5 * config.PLATE_FRONT_IN * back, -(side + back / 3.0)
    zc = (rect_a * rect_z + tri_a * tri_z) / (rect_a + tri_a)
    pts[:, 2] -= zc
    return pts * IN_TO_M


OBJP = plate_object_points()

# IPPE's planar solver expects the target in its own Z=0 plane. Our world target
# lies in Y=0, so we solve in a plate-local Z=0 frame and rotate the pose back.
# Local axes in world: Xl=+X, Yl=−Z, Zl=+Y(normal) → R_LW maps local→world.
R_LW = np.array([[1, 0, 0],
                 [0, 0, 1],
                 [0, -1, 0]], dtype=np.float64)
OBJP_LOCAL = np.column_stack([OBJP[:, 0], -OBJP[:, 2], np.zeros(len(OBJP))]).astype(np.float64)


# ── Corner ordering ───────────────────────────────────────────────────────────

def canonical_order(pts: np.ndarray) -> Optional[np.ndarray]:
    """Order 5 detected corners as [A, B, MB, BP, MA] — front edge first (the
    longest edge), then walking the pentagon. Resolves nothing about left/right;
    that is decided later by reprojection. Returns None if degenerate."""
    if pts is None or len(pts) != 5:
        return None
    c = pts.mean(axis=0)
    ang = np.arctan2(pts[:, 1] - c[1], pts[:, 0] - c[0])
    order = np.argsort(ang)                       # CCW around centroid
    p = pts[order]
    # Longest edge = front edge
    edges = [np.linalg.norm(p[i] - p[(i + 1) % 5]) for i in range(5)]
    i = int(np.argmax(edges))
    return np.array([p[(i + k) % 5] for k in range(5)], dtype=np.float64)


# ── Intrinsics ────────────────────────────────────────────────────────────────

def build_K(width: int, height: int, focal_px: Optional[float] = None) -> np.ndarray:
    f = focal_px if focal_px is not None else config.focal_px(width=width)
    return np.array([[f, 0, width / 2.0],
                     [0, f, height / 2.0],
                     [0, 0, 1.0]], dtype=np.float64)


def refine_focal_from_homography(corners_canon: np.ndarray, width: int, height: int) -> Optional[float]:
    """Estimate focal length from the plate-plane→image homography, assuming a
    central principal point, square pixels and zero skew (orthogonality of the
    homography's first two columns)."""
    obj_xz = OBJP[:, [0, 2]].astype(np.float64)   # plate plane coords (X,Z)
    img = canon_to_objorder(corners_canon)        # match OBJP order
    if img is None:
        return None
    H, _ = cv2.findHomography(obj_xz, img, method=0)
    if H is None:
        return None
    cx, cy = width / 2.0, height / 2.0
    T = np.array([[1, 0, -cx], [0, 1, -cy], [0, 0, 1.0]])
    Hn = T @ H
    h1, h2 = Hn[:, 0], Hn[:, 1]
    denom = h1[2] * h2[2]
    if abs(denom) < 1e-12:
        return None
    f2 = -(h1[0] * h2[0] + h1[1] * h2[1]) / denom
    if f2 <= 0:
        return None
    f = float(np.sqrt(f2))
    # Sanity clamp to a plausible range around the lens-derived value
    nominal = config.focal_px(width=width)
    if f < 0.3 * nominal or f > 3.0 * nominal:
        return None
    return f


def canon_to_objorder(c: np.ndarray) -> Optional[np.ndarray]:
    """Map canonical [A,B,MB,BP,MA] to OBJP order [FL,FR,MR,BP,ML] (candidate 1)."""
    if c is None:
        return None
    return np.array([c[0], c[1], c[2], c[3], c[4]], dtype=np.float64)


# ── PnP with left/right disambiguation ────────────────────────────────────────

def solve_pose(corners_canon: np.ndarray, K: np.ndarray, D: np.ndarray
               ) -> Optional[Tuple[np.ndarray, np.ndarray, float, np.ndarray]]:
    """Return (R, t, reproj_px, img_world_order) for world→camera.

    Two ambiguities are resolved here:
      • left/right corner labelling — try both, prefer the better reprojection;
      • the planar two-fold pose ambiguity (a small flat target admits two tilt
        solutions with equal reprojection) — broken with the physical prior that
        the camera sits ABOVE the plate (world camera-centre Y > 0).
    img_world_order is the detected pixels reordered to OBJP order for the winner.
    """
    c = corners_canon
    candidates = [
        np.array([c[0], c[1], c[2], c[3], c[4]]),   # FL,FR,MR,BP,ML
        np.array([c[1], c[0], c[4], c[3], c[2]]),   # mirror (swap L/R)
    ]
    best = None  # (score, R_world, t, err, img)
    objp_l = OBJP_LOCAL.reshape(-1, 1, 3)
    for img in candidates:
        imgr = img.astype(np.float64).reshape(-1, 1, 2)
        try:
            n, rvecs, tvecs, errs = cv2.solvePnPGeneric(objp_l, imgr, K, D,
                                                        flags=cv2.SOLVEPNP_IPPE)
            sols = list(zip(rvecs, tvecs))
        except cv2.error:
            ok, rvec, tvec = cv2.solvePnP(objp_l, imgr, K, D, flags=cv2.SOLVEPNP_ITERATIVE)
            sols = [(rvec, tvec)] if ok else []
        for rvec, tvec in sols:
            R_lc, _ = cv2.Rodrigues(rvec)
            t = np.asarray(tvec).reshape(3)
            proj, _ = cv2.projectPoints(OBJP_LOCAL, rvec, t, K, D)
            err = float(np.sqrt(np.mean(np.sum(
                (proj.reshape(-1, 2) - imgr.reshape(-1, 2)) ** 2, axis=1))))
            R_wc = R_lc @ R_LW.T                   # local→cam composed to world→cam
            cam_center = (-R_wc.T @ t)             # camera position in world
            above = cam_center[1] > 0              # physical prior: camera above plate
            score = err + (0.0 if above else 1000.0)
            if best is None or score < best[0]:
                best = (score, R_wc, t, err, img.astype(np.float64))
    if best is None:
        return None
    return best[1], best[2], best[3], best[4]


def projection_matrix(K: np.ndarray, R: np.ndarray, t: np.ndarray) -> np.ndarray:
    return K @ np.hstack([R, t.reshape(3, 1)])


# ── Capture / averaging ───────────────────────────────────────────────────────

def _open(idx: int):
    cap = cv2.VideoCapture(idx, config.CAMERA_BACKEND)
    if config.CAMERA_FOURCC:
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*config.CAMERA_FOURCC))
    cap.set(cv2.CAP_PROP_FRAME_WIDTH,  config.WIDTH)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, config.HEIGHT)
    if config.APPLY_EXPOSURE:
        cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25)
        cap.set(cv2.CAP_PROP_EXPOSURE, float(config.EXPOSURE_VALUE))
    return cap


def average_corners_live(frames: int) -> Tuple[Optional[np.ndarray], Optional[np.ndarray], Tuple[int, int]]:
    """Grab `frames` detections from both cameras and average the canonical
    corner positions (plate + cameras are static, so this denoises the solve)."""
    cap0, cap1 = _open(config.CAM0_IDX), _open(config.CAM1_IDX)
    if not cap0.isOpened() or not cap1.isOpened():
        print("Cannot open one or both cameras. Run camera_check.py to diagnose.")
        sys.exit(1)
    print(f"Detector: {'learned CNN' if using_learned_model() else 'classical'}")
    print("Place a home plate flat in BOTH camera views. Hold steady …")

    acc0, acc1, n = [], [], 0
    img_size = (config.WIDTH, config.HEIGHT)
    while n < frames:
        ok0, f0 = cap0.read()
        ok1, f1 = cap1.read()
        if not ok0 or not ok1:
            continue
        c0 = canonical_order(detect_plate_corners(f0))
        c1 = canonical_order(detect_plate_corners(f1))

        disp = np.hstack([_annot(f0, c0, "CAM0"), _annot(f1, c1, "CAM1")])
        cv2.putText(disp, f"{n}/{frames} samples  (ESC to abort)", (8, 22),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 220, 0), 1)
        cv2.imshow("OVLM Plate Calibration", disp)
        if (cv2.waitKey(1) & 0xFF) == 27:
            break
        if c0 is not None and c1 is not None:
            acc0.append(c0); acc1.append(c1); n += 1

    cv2.destroyAllWindows()
    cap0.release(); cap1.release()
    if n < max(5, frames // 4):
        print(f"Only {n} good detections — plate not reliably seen in both cameras.")
        return None, None, img_size
    return np.mean(acc0, axis=0), np.mean(acc1, axis=0), img_size


def _annotate_jpeg(frame: np.ndarray, corners, label: str, count: int, total: int) -> bytes:
    """Annotate a frame with plate corners and encode to JPEG for browser preview."""
    d = frame.copy()
    h, w = d.shape[:2]
    if (w, h) != (_PREVIEW_W, _PREVIEW_H):
        sx, sy = _PREVIEW_W / w, _PREVIEW_H / h
        d = cv2.resize(d, (_PREVIEW_W, _PREVIEW_H))
        if corners is not None:
            corners = corners * np.array([sx, sy])
    if corners is not None:
        for i, p in enumerate(corners):
            cv2.circle(d, (int(p[0]), int(p[1])), 6, (0, 220, 60), -1)
            cv2.putText(d, str(i), (int(p[0]) + 7, int(p[1]) - 5),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 220, 60), 1)
        cv2.polylines(d, [corners.astype(np.int32)], True, (0, 200, 50), 2)
        status_col, status_txt = (0, 220, 60), "PLATE FOUND"
    else:
        cv2.putText(d, "SEARCHING...", (8, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (60, 60, 220), 2)
        status_col, status_txt = (60, 60, 220), "SEARCHING"
    cv2.putText(d, label, (8, _PREVIEW_H - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (180, 180, 180), 1)
    cv2.putText(d, status_txt, (_PREVIEW_W - 160, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.55, status_col, 2)
    if count > 0:
        cv2.putText(d, f"{count}/{total}", (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (60, 180, 220), 2)
    _, buf = cv2.imencode(".jpg", d, [cv2.IMWRITE_JPEG_QUALITY, 72])
    return bytes(buf)


class LiveCollector:
    """Always-on plate-corner accumulator driven by live stereo frame pairs.

    Runs continuously as a preview (storing the latest annotated frames so the
    browser can show live plate-detection overlays), but only accumulates
    calibration samples after start_collecting() is called. This gives a
    Trackman-style UX: cameras are always live, one click starts the solve.

    Detection runs in a dedicated background thread so feed() returns immediately
    and never stalls the 210 fps stereo capture pair-loop. Every `every_nth`
    frames a new frame pair is posted to the detector; if it is still busy the
    frame is dropped (the detector always works on the most recent one). The UI
    preview updates on every feed() call.
    """

    def __init__(self, frames: int = config.PLATE_CALIB_FRAMES,
                 every_nth: int = 30) -> None:
        self.frames    = frames
        self.every_nth = every_nth
        self._acc0: list = []
        self._acc1: list = []
        self._collecting = False
        self._lock  = threading.Lock()
        self._last  = None          # (left_bgr, right_bgr, corners0, corners1)
        self._feed_n = 0

        # Background detector: single daemon thread with a frame-dropping inbox.
        # The capture thread writes to _detect_pending and signals _detect_event;
        # the detector grabs the latest frame, clears the inbox, then runs
        # detect_plate_corners without holding any lock.
        self._detect_pending: Optional[Tuple[np.ndarray, np.ndarray]] = None
        self._detect_lock  = threading.Lock()
        self._detect_event = threading.Event()
        threading.Thread(target=self._detect_loop, daemon=True,
                         name="plate-detect").start()

    # ── Background detection thread ───────────────────────────────────────────

    def _detect_loop(self) -> None:
        while True:
            self._detect_event.wait()
            self._detect_event.clear()

            with self._detect_lock:
                pending = self._detect_pending
                self._detect_pending = None
            if pending is None:
                continue
            left, right = pending

            try:
                c0 = canonical_order(detect_plate_corners(left))
                c1 = canonical_order(detect_plate_corners(right))
            except Exception:
                c0 = c1 = None

            with self._lock:
                # Stamp latest corners onto the current frame snapshot
                if self._last is not None:
                    fl, fr, _, _ = self._last
                    self._last = (fl, fr, c0, c1)
                # Accumulate if we're collecting and haven't hit the target yet
                if (self._collecting and c0 is not None and c1 is not None
                        and len(self._acc0) < self.frames):
                    self._acc0.append(c0)
                    self._acc1.append(c1)

    # ── Public properties ─────────────────────────────────────────────────────

    @property
    def count(self) -> int:
        return len(self._acc0)

    @property
    def done(self) -> bool:
        return self._collecting and len(self._acc0) >= self.frames

    @property
    def collecting(self) -> bool:
        return self._collecting

    @property
    def step(self) -> str:
        """Mirrors CalibSession.step for compatibility with stream_calib_frames."""
        if self.done:
            return 'done'
        return 'capturing' if self._collecting else 'align'

    # ── Control ───────────────────────────────────────────────────────────────

    def start_collecting(self) -> None:
        """Begin accumulating samples. Safe to call from any thread."""
        with self._lock:
            self._acc0.clear()
            self._acc1.clear()
            self._collecting = True

    def stop_collecting(self) -> None:
        with self._lock:
            self._collecting = False

    # ── Frame feed (called from capture thread) ───────────────────────────────

    def feed(self, left: np.ndarray, right: np.ndarray) -> bool:
        """Store the latest frame pair for preview; post to detector if due.

        Returns immediately — detection runs in the background thread. The UI
        preview updates on every call; plate-corner detection and accumulation
        happen asynchronously without blocking the capture pair-loop.
        """
        self._feed_n += 1
        left_snap  = left.copy()
        right_snap = right.copy()

        with self._lock:
            prev_c0 = self._last[2] if self._last is not None else None
            prev_c1 = self._last[3] if self._last is not None else None
            self._last = (left_snap, right_snap, prev_c0, prev_c1)

        if self._feed_n % self.every_nth == 0:
            with self._detect_lock:
                self._detect_pending = (left_snap, right_snap)
            self._detect_event.set()

        return False

    # ── Preview (called from server async loop at ~15 fps) ───────────────────

    def grab_annotated(self) -> Tuple[bytes, bytes, bool, bool]:
        """Return (jpeg0, jpeg1, found0, found1) — safe to call from any thread."""
        with self._lock:
            last = self._last
        count = self.count
        if last is None:
            blank = np.zeros((_PREVIEW_H, _PREVIEW_W, 3), dtype=np.uint8)
            cv2.putText(blank, "WAITING FOR CAMERAS...", (8, _PREVIEW_H // 2),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.65, (50, 50, 50), 2)
            _, b = cv2.imencode(".jpg", blank, [cv2.IMWRITE_JPEG_QUALITY, 72])
            bw = bytes(b)
            return bw, bw, False, False
        left, right, c0, c1 = last
        j0 = _annotate_jpeg(left,  c0, "CAM 0", count, self.frames)
        j1 = _annotate_jpeg(right, c1, "CAM 1", count, self.frames)
        return j0, j1, (c0 is not None), (c1 is not None)

    # ── Solve ─────────────────────────────────────────────────────────────────

    def solve(self, out_path: str, focal_mm: Optional[float] = None) -> Optional[dict]:
        """Average accumulated samples and run the stereo PnP solve.
        Returns result dict on success, None on failure."""
        if len(self._acc0) < max(5, self.frames // 4):
            return None
        c0 = np.mean(self._acc0, axis=0)
        c1 = np.mean(self._acc1, axis=0)
        img_size = (config.WIDTH, config.HEIGHT)
        if not calibrate(c0, c1, img_size, out_path, refine_focal=False, focal_mm=focal_mm):
            return None
        data = np.load(out_path)
        return {
            "baselineMm": float(data["baseline_mm"]),
            "reprojPx":   float(data["reproj_px"]),
            "rmsMm":      float(data["triangulation_rms_mm"]),
        }


def solve_from_manual_corners(
    corners0: list,
    corners1: list,
    img_size: tuple,
    out_path: str,
    height_mm: float = 0.0,
    dist_mm: float = 0.0,
    focal_mm: Optional[float] = None,
) -> Optional[dict]:
    """Solve stereo calibration from manually-clicked corners.

    corners0 / corners1 are lists of 5 [x, y] pairs in click order:
    [FL, FR, MR, BP, ML] — matching plate_object_points(). The solver
    tries both the supplied ordering and its L/R mirror, so minor
    left/right confusion is self-correcting.

    height_mm and dist_mm (rig measurements) are stored in the output
    file for reference; they don't affect the PnP math.
    """
    if len(corners0) != 5 or len(corners1) != 5:
        return None
    c0 = np.array(corners0, dtype=np.float64)
    c1 = np.array(corners1, dtype=np.float64)
    if not calibrate(c0, c1, img_size, out_path, refine_focal=False, focal_mm=focal_mm):
        return None
    data = np.load(out_path, allow_pickle=True)
    # Re-save with rig measurements appended
    np.savez(
        out_path,
        **{k: data[k] for k in data.files},
        rig_height_mm=np.float64(height_mm),
        rig_dist_mm=np.float64(dist_mm),
    )
    return {
        "baselineMm": float(data["baseline_mm"]),
        "reprojPx":   float(data["reproj_px"]),
        "rmsMm":      float(data["triangulation_rms_mm"]),
    }


def _annot(frame, corners, label):
    d = frame.copy()
    cv2.putText(d, label, (8, config.HEIGHT - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                (200, 200, 200), 1)
    if corners is not None:
        for i, p in enumerate(corners):
            cv2.circle(d, (int(p[0]), int(p[1])), 4, (0, 165, 255), -1)
            cv2.putText(d, str(i), (int(p[0]) + 5, int(p[1]) - 5),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 165, 255), 1)
        cv2.polylines(d, [corners.astype(np.int32)], True, (0, 220, 0), 1)
    else:
        cv2.putText(d, "no plate", (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 220), 1)
    return d


# ── Solve + save ──────────────────────────────────────────────────────────────

def calibrate(c0: np.ndarray, c1: np.ndarray, img_size, out_path: str,
              refine_focal: bool, focal_mm: Optional[float] = None) -> bool:
    W, H = img_size
    focal = config.focal_px(focal_mm=focal_mm, width=W) if focal_mm is not None else None
    if refine_focal:
        f0 = refine_focal_from_homography(c0, W, H)
        f1 = refine_focal_from_homography(c1, W, H)
        cand = [f for f in (f0, f1) if f]
        if cand:
            focal = float(np.mean(cand))
            print(f"Focal length refined from plate homography: {focal:.1f} px "
                  f"(lens-derived was {config.focal_px(width=W):.1f} px)")
        else:
            print("Focal refinement failed; using lens-derived focal length.")

    K0 = build_K(W, H, focal)
    K1 = build_K(W, H, focal)
    D0 = np.zeros((1, 5)); D1 = np.zeros((1, 5))

    s0 = solve_pose(c0, K0, D0)
    s1 = solve_pose(c1, K1, D1)
    if s0 is None or s1 is None:
        print("PnP failed for one or both cameras.")
        return False
    R0w, t0w, e0, img0 = s0
    R1w, t1w, e1, img1 = s1
    print(f"Per-camera reprojection error:  cam0 {e0:.2f} px   cam1 {e1:.2f} px")

    P0 = projection_matrix(K0, R0w, t0w)          # world → image (raw pixels)
    P1 = projection_matrix(K1, R1w, t1w)

    # Relative pose cam0 → cam1 and baseline
    R = R1w @ R0w.T
    T = (t1w - R @ t0w).reshape(3, 1)
    baseline_mm = float(np.linalg.norm(T)) * 1000.0

    # Self-check: triangulate the plate corners back, compare to known geometry.
    # Each camera's pixels are in world-point order (img0/img1) so they correspond.
    Xh = cv2.triangulatePoints(P0, P1, img0.T, img1.T)
    Xh /= Xh[3]
    resid = Xh[:3].T - OBJP
    rms_mm = float(np.sqrt(np.mean(np.sum(resid ** 2, axis=1)))) * 1000.0

    # Rectification (for the optional verify preview only — NOT used by triangulate)
    Rr0, Rr1, Pr0, Pr1, Q, _, _ = cv2.stereoRectify(
        K0, D0, K1, D1, (W, H), R, T, flags=cv2.CALIB_ZERO_DISPARITY, alpha=0)

    np.savez(
        out_path,
        P0=P0, P1=P1,                      # consumed by triangulate.py
        K0=K0, D0=D0, K1=K1, D1=D1, R=R, T=T,
        Rrect0=Rr0, Rrect1=Rr1, Prect0=Pr0, Prect1=Pr1, Q=Q,
        img_size=np.array([W, H]),
        baseline_mm=np.float64(baseline_mm),
        reproj_px=np.float64(max(e0, e1)),
        triangulation_rms_mm=np.float64(rms_mm),
        method=np.array("home_plate_pnp"),
    )
    print(f"\nBaseline: {baseline_mm:.1f} mm   |   plate self-check RMS: {rms_mm:.1f} mm")
    grade = ("Excellent" if rms_mm < 5 and max(e0, e1) < 1.5 else
             "Good" if rms_mm < 15 and max(e0, e1) < 3 else
             "Rough — move the plate larger in frame / improve lighting / refine focal")
    print(f"Quality: {grade}")
    print(f"Saved → {out_path}")
    return True


# ── Verify (rectified epipolar preview) ───────────────────────────────────────

def verify(cal_path: str) -> None:
    data = np.load(cal_path)
    if "Prect0" not in data:
        print("This calibration has no rectification data (not a plate calibration?).")
        return
    K0, D0, K1, D1 = data["K0"], data["D0"], data["K1"], data["D1"]
    Rr0, Rr1, Pr0, Pr1 = data["Rrect0"], data["Rrect1"], data["Prect0"], data["Prect1"]
    W, H = tuple(data["img_size"].astype(int))
    m0x, m0y = cv2.initUndistortRectifyMap(K0, D0, Rr0, Pr0, (W, H), cv2.CV_32FC1)
    m1x, m1y = cv2.initUndistortRectifyMap(K1, D1, Rr1, Pr1, (W, H), cv2.CV_32FC1)
    cap0, cap1 = _open(config.CAM0_IDX), _open(config.CAM1_IDX)
    print("Rectified preview — horizontal lines should cross matching features. ESC to quit.")
    while True:
        ok0, f0 = cap0.read(); ok1, f1 = cap1.read()
        if not ok0 or not ok1:
            continue
        r0 = cv2.remap(f0, m0x, m0y, cv2.INTER_LINEAR)
        r1 = cv2.remap(f1, m1x, m1y, cv2.INTER_LINEAR)
        comb = np.hstack([r0, r1])
        for y in range(0, comb.shape[0], comb.shape[0] // 12):
            cv2.line(comb, (0, y), (comb.shape[1], y), (0, 255, 0), 1)
        cv2.imshow("Plate Calibration Verify", comb)
        if (cv2.waitKey(1) & 0xFF) == 27:
            break
    cv2.destroyAllWindows(); cap0.release(); cap1.release()


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description="OVLM home-plate stereo calibration")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--live", action="store_true", help="Capture from both cameras")
    mode.add_argument("--pair", nargs=2, metavar=("LEFT", "RIGHT"),
                      help="Solve from a saved left/right image pair")
    mode.add_argument("--verify", action="store_true", help="Rectified epipolar preview")
    ap.add_argument("--out", default=config.CALIBRATION_FILE, help="Output .npz path")
    ap.add_argument("--cal", default=config.CALIBRATION_FILE, help="Calibration to verify")
    ap.add_argument("--frames", type=int, default=config.PLATE_CALIB_FRAMES,
                    help="Frames to average (live mode)")
    ap.add_argument("--refine-focal", action="store_true",
                    help="Estimate focal length from the plate homography")
    args = ap.parse_args()

    if args.verify:
        verify(args.cal)
        return

    if args.live:
        c0, c1, img_size = average_corners_live(args.frames)
    else:
        f0 = cv2.imread(args.pair[0]); f1 = cv2.imread(args.pair[1])
        if f0 is None or f1 is None:
            print("Could not read one of the image-pair files."); sys.exit(1)
        img_size = (f0.shape[1], f0.shape[0])
        c0 = canonical_order(detect_plate_corners(f0))
        c1 = canonical_order(detect_plate_corners(f1))

    if c0 is None or c1 is None:
        print("Plate not detected in both views — aborting.")
        sys.exit(1)
    ok = calibrate(c0, c1, img_size, args.out, args.refine_focal)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
