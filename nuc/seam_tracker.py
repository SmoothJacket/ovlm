"""
Spin rate estimation via seam tracking.

Method: Log-Polar Phase Correlation
────────────────────────────────────
For each consecutive frame pair with a detected ball:
  1. Crop a circular patch centred on the ball, resize to PATCH_SIZE²
  2. Mask to the ball circle to suppress background
  3. Apply DoG (Difference of Gaussians) to enhance dark seam edges
  4. Log-polar transform: rotation in Cartesian → vertical shift in log-polar
  5. cv2.phaseCorrelate gives the sub-pixel vertical shift → angle per frame
  6. Angular velocity = angle / Δt → RPM

Spin axis estimation (simplified)
──────────────────────────────────
The log-polar shift direction (CW vs CCW) tells us the sense of rotation
as seen by the camera. We project this onto a 3D axis assuming the camera
looks roughly perpendicular to the ball flight path (+Z direction).

Limitation: single-camera seam tracking gives the spin axis component
perpendicular to the line of sight. True 3D axis needs two cameras or IMU.

Practical ceiling scales with fps (180° Nyquist limit, ~75% usable):
~4 700 RPM at the stereo pair's 210 fps, ~9 400 RPM at the optional
420 fps spin camera.
"""

import math
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, List, Optional, Tuple

import cv2
import numpy as np

from detect import Detection2D

# ── Tuning ────────────────────────────────────────────────────────────────────
PATCH_SIZE     = 64     # log-polar grid resolution (power of 2 is fastest for FFT)
CROP_RADIUS_MULT = 2.5  # crop this many × detected radius around ball centre
MIN_FRAMES     = 5      # minimum rotation samples for a valid measurement
MIN_CONFIDENCE = 0.08   # phaseCorrelate response threshold (0–1)
DOG_SIGMA1     = 1.0    # DoG fine scale (seam width ≈ 1–2 px after resize)
DOG_SIGMA2     = 3.0    # DoG coarse scale


@dataclass
class SpinMeasurement:
    spin_rate_rpm:    float
    spin_axis:        Tuple[float, float, float]   # 3-D unit vector (world frame)
    spin_efficiency:  float    # active spin fraction 0–1 (transverse / total)
    frames_analyzed:  int
    confidence:       float    # mean phase correlation response
    axis_confidence:  float = 1.0   # 0–1: how reliable is the axis direction
    gyro_angle_deg:   float = 0.0   # estimated tilt of spin axis toward velocity


@dataclass
class _Sample:
    angle_rad:  float   # rotation from prev → this frame (radians)
    dt:         float   # time between frames (seconds)
    response:   float   # phaseCorrelate peak response (quality)


class SeamTracker:
    """
    Process frames one at a time with process_frame(), then call
    compute_spin() after the ball window is complete.
    """

    def __init__(self) -> None:
        self._prev_lp:    Optional[np.ndarray] = None
        self._prev_ts:    float = 0.0
        self._samples:    List[_Sample] = []
        self._seam_frames: List[int] = []

    # ── Public API ────────────────────────────────────────────────────────────

    def process_frame(
        self,
        frame_bgr: np.ndarray,
        det: Detection2D,
        timestamp: float,
        frame_idx: int,
    ) -> bool:
        """
        Extract seam features from one frame.
        Returns True if a usable patch was extracted.
        """
        patch = self._extract_patch(frame_bgr, det)
        if patch is None:
            self._prev_lp = None
            return False

        lp = self._to_log_polar(patch)

        if self._prev_lp is not None and self._prev_ts > 0:
            shift, response = cv2.phaseCorrelate(self._prev_lp, lp)
            if response >= MIN_CONFIDENCE:
                # shift[1] in log-polar Y = fraction of full circle rotated
                angle_rad = (shift[1] / PATCH_SIZE) * 2.0 * math.pi
                dt = timestamp - self._prev_ts
                if dt > 0:
                    self._samples.append(_Sample(angle_rad, dt, response))
                    self._seam_frames.append(frame_idx)

        self._prev_lp = lp
        self._prev_ts = timestamp
        return True

    def compute_spin(self) -> Optional[SpinMeasurement]:
        """Call after all frames have been processed. Returns None if too few samples."""
        good = [s for s in self._samples if s.response >= MIN_CONFIDENCE]
        if len(good) < MIN_FRAMES:
            return None

        # Angular velocity (rad/s) per sample
        ang_vels = np.array([s.angle_rad / s.dt for s in good])
        weights   = np.array([s.response    for s in good])

        # Weighted median — robust against occasional bad frames
        omega = _weighted_median(ang_vels, weights)
        confidence = float(np.mean(weights))

        rpm = abs(omega) * 60.0 / (2.0 * math.pi)

        # ── Spin axis estimation ──────────────────────────────────────────────
        # omega > 0 → CCW rotation in image → spin axis points toward camera (+Z)
        # omega < 0 → CW  rotation in image → spin axis points away    (−Z)
        # We add a small Y component (upward) as a Trackman-style convention
        # placeholder; true 3D axis needs stereo or IMU fusion.
        sign = 1.0 if omega >= 0 else -1.0
        raw_axis = np.array([0.0, 0.1 * sign, sign])   # mostly Z ± slight Y
        spin_axis = raw_axis / np.linalg.norm(raw_axis)

        # Spin efficiency: ratio of primary-axis spin to total. Without gyro
        # data we use phase-correlation consistency as a proxy.
        std_omega = float(np.std([s.angle_rad / s.dt for s in good]))
        spin_efficiency = max(0.0, 1.0 - std_omega / (abs(omega) + 1e-9))
        spin_efficiency = min(1.0, spin_efficiency)

        return SpinMeasurement(
            spin_rate_rpm=round(rpm, 0),
            spin_axis=(round(float(spin_axis[0]), 3),
                       round(float(spin_axis[1]), 3),
                       round(float(spin_axis[2]), 3)),
            spin_efficiency=round(spin_efficiency, 3),
            frames_analyzed=len(good),
            confidence=round(confidence, 3),
        )

    def compute_spin_with_axis(
        self,
        spin_axis: tuple,
        cam_los: tuple = (0.0, 0.0, 1.0),
    ) -> Optional['SpinMeasurement']:
        """
        Compute gyro-corrected spin rate using a known 3-D spin axis.

        The camera only sees the component of spin perpendicular to its line
        of sight (LOS). A slider with 40° gyro angle looks 36% slower than it
        really is. Dividing by sin(angle between axis and LOS) recovers the
        true rate.

        Integration over the full flight (total_angle / total_time) is used
        instead of a per-frame median — a single blurred frame changes the
        total by at most one frame's contribution, whereas it can dominate
        a per-frame median.

        Returns None when there are too few samples or the axis is nearly
        parallel to the LOS (gyro_factor < 0.15, i.e. > ~81° gyro angle),
        where phase-correlation becomes unreliable and the caller should fall
        back to the Magnus-only rate.
        """
        good = [s for s in self._samples if s.response >= MIN_CONFIDENCE]
        if len(good) < MIN_FRAMES:
            return None

        total_angle = sum(s.angle_rad for s in good)
        total_time  = sum(s.dt        for s in good)
        if total_time <= 0:
            return None

        raw_omega = abs(total_angle / total_time)   # rad/s apparent (projected)

        # |sin(θ)| between spin axis and camera LOS = magnitude of cross product
        ax = np.array(spin_axis, dtype=float)
        cl = np.array(cam_los,   dtype=float)
        ax_n = float(np.linalg.norm(ax))
        cl_n = float(np.linalg.norm(cl))
        if ax_n < 1e-9 or cl_n < 1e-9:
            return None
        gyro_factor = float(np.linalg.norm(np.cross(ax / ax_n, cl / cl_n)))

        if gyro_factor < 0.15:
            # Axis nearly parallel to camera LOS — near-pure gyro spin.
            # Seam appears to rotate like a coin face-on; phase correlation
            # cannot recover the true rate reliably.
            return None

        true_omega = raw_omega / gyro_factor
        rpm_active = true_omega * 60.0 / (2.0 * math.pi)

        confidence = float(np.mean([s.response for s in good]))

        # ── Gyro angle estimation from crossing-rate variance ─────────────────
        # Pure transverse spin → constant frame-to-frame ω (low variance).
        # A gyro component tilts the spin axis toward/away from the camera
        # each half revolution, creating sinusoidal modulation in apparent ω.
        # Empirical approximation: normalised std ≈ sin(gyro_angle) / √2.
        # gyro_angle: 0° = pure transverse (fastball backspin), 90° = pure gyro.
        per_frame  = [s.angle_rad / s.dt for s in good]
        std_v      = float(np.std(per_frame))
        mean_v_abs = abs(float(np.mean(per_frame)))

        if mean_v_abs > 0:
            gyro_sin = min(1.0, math.sqrt(2.0) * std_v / (mean_v_abs + 1e-9))
        else:
            gyro_sin = 0.0

        # Sign: total_angle > 0 → CCW seen from behind plate (camera at −Z
        # looking in +Z) → spin axis points toward pitcher (+Z) → LHP-style
        # gyro is negative.  CW (total_angle < 0) → RHP-style → positive.
        gyro_sign = -1.0 if total_angle > 0 else 1.0

        # gyro_angle: −90 to +90°; 0 = pure transverse, ±90 = pure gyroball
        # positive = RHP-style (axis toward plate), negative = LHP-style (+Z)
        gyro_angle_deg  = gyro_sign * math.degrees(math.asin(gyro_sin))
        active_fraction = math.sqrt(max(0.0, 1.0 - gyro_sin ** 2))  # cos(|gyro_angle|)

        # Total RPM = active / cos(|gyro_angle|); only when gyro estimate is valid.
        if active_fraction > 0.30:
            rpm_total = rpm_active / active_fraction
        else:
            rpm_total = rpm_active   # too much gyro — don't amplify noise

        # ── Refine 3D axis: add velocity-direction (gyro) component ──────────
        # Magnus gives the transverse axis (X-Y plane).
        # Gyro component: −Z for RHP (toward plate), +Z for LHP (toward pitcher).
        # axis = cos(|gyro_angle|) · transverse_hat ± sin(|gyro_angle|) · Z_hat
        trans = np.array(spin_axis, dtype=float)
        trans[2] = 0.0   # drop any Z in the provided Magnus axis (unmeasured)
        t_norm = float(np.linalg.norm(trans))
        if t_norm > 1e-9:
            trans /= t_norm
            gyro_dir = np.array([0.0, 0.0, -gyro_sign])  # −Z = RHP, +Z = LHP
            full = trans * active_fraction + gyro_dir * gyro_sin
            fn = float(np.linalg.norm(full))
            refined_axis = tuple(round(float(x), 3) for x in (full / fn if fn > 1e-9 else trans))
        else:
            refined_axis = tuple(round(float(x), 3) for x in spin_axis)

        return SpinMeasurement(
            spin_rate_rpm   = round(rpm_total, 0),
            spin_axis       = refined_axis,
            spin_efficiency = round(active_fraction, 3),
            frames_analyzed = len(good),
            confidence      = round(confidence, 3),
            gyro_angle_deg  = round(gyro_angle_deg, 1),
        )

    def reset(self) -> None:
        self._prev_lp    = None
        self._prev_ts    = 0.0
        self._samples    = []
        self._seam_frames = []

    # ── Private helpers ───────────────────────────────────────────────────────

    def _extract_patch(
        self, frame_bgr: np.ndarray, det: Detection2D
    ) -> Optional[np.ndarray]:
        """
        Crop a square region around the ball, apply circular mask,
        enhance seams with DoG, and resize to PATCH_SIZE².
        """
        h, w = frame_bgr.shape[:2]
        r = max(det.radius, 4.0)
        crop_r = int(math.ceil(r * CROP_RADIUS_MULT))

        cx, cy = int(round(det.cx)), int(round(det.cy))
        x1 = max(0, cx - crop_r)
        y1 = max(0, cy - crop_r)
        x2 = min(w, cx + crop_r)
        y2 = min(h, cy + crop_r)

        if x2 - x1 < 4 or y2 - y1 < 4:
            return None

        crop = cv2.cvtColor(frame_bgr[y1:y2, x1:x2], cv2.COLOR_BGR2GRAY).astype(np.float32)

        # Circular mask centred on ball — suppress background motion
        ch, cw = crop.shape
        ball_cx = min(cx - x1, cw - 1)
        ball_cy = min(cy - y1, ch - 1)
        yy, xx  = np.ogrid[:ch, :cw]
        mask    = ((xx - ball_cx) ** 2 + (yy - ball_cy) ** 2) <= r ** 2
        crop   *= mask

        # DoG — highlights dark seam edges (~1–2 px wide)
        g1  = cv2.GaussianBlur(crop, (0, 0), DOG_SIGMA1)
        g2  = cv2.GaussianBlur(crop, (0, 0), DOG_SIGMA2)
        dog = g2 - g1   # seams appear as bright ridges in the difference

        # Normalise to 0–1 for phaseCorrelate stability
        mn, mx = dog.min(), dog.max()
        if mx - mn < 1.0:
            return None   # blank patch — ball not visible or fully masked
        dog = (dog - mn) / (mx - mn)

        return cv2.resize(dog, (PATCH_SIZE, PATCH_SIZE), interpolation=cv2.INTER_LINEAR)

    @staticmethod
    def _to_log_polar(patch: np.ndarray) -> np.ndarray:
        """Convert a square patch to log-polar coordinates."""
        centre = (PATCH_SIZE / 2.0, PATCH_SIZE / 2.0)
        max_r  = PATCH_SIZE / 2.0
        return cv2.warpPolar(
            patch,
            (PATCH_SIZE, PATCH_SIZE),
            centre,
            max_r,
            cv2.WARP_POLAR_LOG + cv2.INTER_LINEAR,
        )


# ── Utility ───────────────────────────────────────────────────────────────────

def _weighted_median(values: np.ndarray, weights: np.ndarray) -> float:
    """Return the weighted median of values."""
    idx      = np.argsort(values)
    vals_s   = values[idx]
    weights_s = weights[idx]
    cumsum   = np.cumsum(weights_s)
    return float(vals_s[np.searchsorted(cumsum, cumsum[-1] / 2.0)])
