"""
Trackman-style pitch metrics derived from the stereo trajectory fit.

Inputs are the τ=0 launch state (release point + velocity, OVLM world frame:
+X = first-base side, +Y = up, +Z = toward the pitcher; metres / m·s⁻¹) and
the optional spin measurement (rate + unit axis). Everything else here is
forward integration / projection — no new fits.

World frame note: the ball is THROWN from the pitcher (+Z side) TOWARD the
plate (origin), so a real pitch has vz < 0 in this frame. The plate plane
is z = 0.

Units returned (matches what scouts read on a Trackman card):
  speeds    → mph
  angles    → degrees
  positions → feet (release height/side, plate location, extension)
  breaks    → inches
  time      → seconds
  spin tilt → "HH:MM" clock-face string
"""

from __future__ import annotations

import math
from dataclasses import dataclass, asdict
from typing import Optional, Sequence

import numpy as np

import config
from trajectory import LaunchMetrics, DRAG_K

M_PER_FT = 0.3048
M_PER_IN = 0.0254
MPS_TO_MPH = 2.23694
RUBBER_FROM_PLATE_FT = 60 + 6 / 12.0       # 60'6"
RUBBER_FROM_PLATE_M  = RUBBER_FROM_PLATE_FT * M_PER_FT


@dataclass
class PitchMetrics:
    release_speed_mph:   float       # |v| at release
    plate_speed_mph:     float       # |v| crossing the front of the plate
    plate_time_s:        float       # release → plate
    plate_loc_x_ft:      float       # X of ball at plate plane (Z=0)
    plate_loc_y_ft:      float       # Y at plate plane (height)
    release_height_ft:   float       # Y of release point
    release_side_ft:     float       # X of release point (+ first-base side)
    extension_ft:        float       # how far in front of the rubber the release sits
    vertical_break_in:   float       # actual_y_at_plate − gravity-only_y_at_plate
    horizontal_break_in: float       # actual_x_at_plate − straight-line_x_at_plate
    total_break_in:      float       # √(VB² + HB²)
    vaa_deg:             float       # vertical approach angle at plate (deg below horizontal = positive)
    haa_deg:             float       # horizontal approach angle at plate
    spin_rate_rpm:       Optional[float] = None
    spin_tilt:           Optional[str]   = None   # "HH:MM" clock face
    active_spin_pct:     Optional[float] = None   # % spin that produces movement


def _integrate_to_plate(
    x0: float, y0: float, z0: float,
    vx: float, vy: float, vz: float,
    magnus_ax: float = 0.0,
    magnus_ay: float = 0.0,
    magnus_az: float = 0.0,
    dt: float = 0.001,
    max_t: float = 2.0,
) -> Optional[tuple]:
    """Walk the ball forward under gravity + drag + Magnus from the launch state
    until z crosses 0 (the plate plane). Magnus acceleration is treated as
    constant over the flight — a good approximation for the short observation
    window from which it was derived. Returns the state at plate crossing or
    None if the ball never reaches the plate within max_t seconds."""
    # Ball thrown toward plate has vz < 0; bail if it's heading the wrong way.
    if vz >= 0 or z0 <= 0:
        return None
    x, y, z = x0, y0, z0
    t = 0.0
    while z > 0 and t < max_t:
        v = math.sqrt(vx * vx + vy * vy + vz * vz)
        ax = -DRAG_K * v * vx + magnus_ax
        ay = -config.GRAVITY_M_S2 - DRAG_K * v * vy + magnus_ay
        az = -DRAG_K * v * vz + magnus_az
        vx += ax * dt
        vy += ay * dt
        vz += az * dt
        x  += vx * dt
        y  += vy * dt
        z  += vz * dt
        t  += dt
    if z > 0:
        return None
    # Linear interpolation back to z = 0 for sub-step precision.
    # Use the previous z to find the fraction of the last step where z crossed.
    # We don't keep the previous state explicitly; reconstruct it from the
    # latest velocity (one step backward is a good enough approximation).
    prev_z = z - vz * dt
    if prev_z <= 0:    # already past, no interpolation needed
        return (x, y, z, vx, vy, vz, t)
    frac = prev_z / (prev_z - z)        # in [0, 1]
    interp_dt = -dt * (1 - frac)
    x += vx * interp_dt
    y += vy * interp_dt
    z  = 0.0
    t += interp_dt
    return (x, y, z, vx, vy, vz, t)


def _gravity_only_xy_at_plate(
    x0: float, y0: float, z0: float,
    vx: float, vy: float, vz: float,
) -> Optional[tuple]:
    """Closed-form (X, Y) at z = 0 under straight-line X + gravity-only Y,
    NO drag, NO Magnus — the reference path used to define VB and HB."""
    if vz >= 0:
        return None
    t = -z0 / vz
    x_g = x0 + vx * t
    y_g = y0 + vy * t - 0.5 * config.GRAVITY_M_S2 * t * t
    return (x_g, y_g, t)


def _spin_axis_to_tilt(spin_axis: Sequence[float]) -> Optional[str]:
    """Convert a 3-D spin-axis unit vector (OVLM frame: +X=first base, +Y=up,
    +Z=toward pitcher) to a baseball tilt clock-face string ("HH:MM").

    Convention: pitcher's mound view looking toward home plate, clockwise
    rotation matches the clock face.

      Spin axis → tilt (for a pitch travelling in −Z)
      (+1, 0, 0)  backspin (4-seam fastball)      → 12:00
      ( 0,−1, 0)  RHP sweeper/slider (breaks 1B)  → 09:00
      (−1, 0, 0)  topspin (12-6 curveball)        → 06:00
      ( 0,+1, 0)  LHP sweeper/slider (breaks 3B)  → 03:00

    Derivation: Magnus force F ∝ ω × v where v ≈ (0,0,−|v|).
    The transverse force components are F_x = −ω_y·|v|, F_y = ω_x·|v|.
    The tilt clock points in the force direction, which maps to:
      θ = atan2(ω_y, ω_x) = atan2(ax_y, ax_x),  0° = 12:00 clockwise.

    The Z component (gyro spin) is invisible to Magnus and dropped here.
    """
    if spin_axis is None or len(spin_axis) < 3:
        return None
    ax_x, ax_y, _ = spin_axis[0], spin_axis[1], spin_axis[2]
    if abs(ax_x) < 1e-6 and abs(ax_y) < 1e-6:
        return "12:00"
    theta = math.atan2(ax_y, ax_x)         # 0 rad = 12:00, clockwise
    if theta < 0:
        theta += 2 * math.pi
    total_minutes = round(theta / (2 * math.pi) * 12 * 60)
    if total_minutes == 12 * 60:
        total_minutes = 0
    hh = total_minutes // 60
    mm = total_minutes % 60
    if hh == 0:
        hh = 12
    return f"{hh:02d}:{mm:02d}"


def compute_pitch_metrics(
    metrics: LaunchMetrics,
    spin_rate_rpm: Optional[float] = None,
    spin_axis:     Optional[Sequence[float]] = None,
    spin_efficiency: Optional[float] = None,
) -> Optional[PitchMetrics]:
    """Project the trajectory forward to the plate and derive Trackman-style
    metrics. Returns None when the launch state can't possibly be a pitch
    (ball travelling away from the plate, or doesn't reach the plate)."""
    plate = _integrate_to_plate(
        metrics.release_x, metrics.release_y, metrics.release_z,
        metrics.vx0,        metrics.vy0,       metrics.vz0,
        magnus_ax=metrics.magnus_ax,
        magnus_ay=metrics.magnus_ay,
        magnus_az=metrics.magnus_az,
    )
    if plate is None:
        return None
    x_p, y_p, _, vx_p, vy_p, vz_p, t_p = plate

    # Reference (no-drag, no-Magnus) trajectory for break.
    gref = _gravity_only_xy_at_plate(
        metrics.release_x, metrics.release_y, metrics.release_z,
        metrics.vx0,        metrics.vy0,       metrics.vz0,
    )
    if gref is None:
        return None
    x_g, y_g, _ = gref

    release_speed_mph = math.hypot(metrics.vx0, math.hypot(metrics.vy0, metrics.vz0)) * MPS_TO_MPH
    plate_speed_mph   = math.hypot(vx_p,        math.hypot(vy_p,        vz_p))        * MPS_TO_MPH

    # Approach angles at the plate. VAA reported as a POSITIVE number for a
    # ball descending (the convention scouts use).
    horiz_speed_plate = math.hypot(vx_p, vz_p)
    vaa_deg = math.degrees(math.atan2(-vy_p, horiz_speed_plate))
    haa_deg = math.degrees(math.atan2(vx_p, -vz_p))   # ball flying toward plate = +Z basis flipped

    # Extension: how far in front of the rubber the ball was released.
    extension_m  = RUBBER_FROM_PLATE_M - metrics.release_z
    extension_ft = extension_m / M_PER_FT

    return PitchMetrics(
        release_speed_mph   = round(release_speed_mph, 2),
        plate_speed_mph     = round(plate_speed_mph, 2),
        plate_time_s        = round(t_p, 3),
        plate_loc_x_ft      = round(x_p / M_PER_FT, 2),
        plate_loc_y_ft      = round(y_p / M_PER_FT, 2),
        release_height_ft   = round(metrics.release_y / M_PER_FT, 2),
        release_side_ft     = round(metrics.release_x / M_PER_FT, 2),
        extension_ft        = round(extension_ft, 2),
        vertical_break_in   = round((y_p - y_g) / M_PER_IN, 2),
        horizontal_break_in = round((x_p - x_g) / M_PER_IN, 2),
        total_break_in      = round(math.hypot(x_p - x_g, y_p - y_g) / M_PER_IN, 2),
        vaa_deg             = round(vaa_deg, 2),
        haa_deg             = round(haa_deg, 2),
        spin_rate_rpm       = round(spin_rate_rpm, 0)         if spin_rate_rpm  is not None else None,
        spin_tilt           = _spin_axis_to_tilt(spin_axis)   if spin_axis      is not None else None,
        active_spin_pct     = round(spin_efficiency * 100, 1) if spin_efficiency is not None else None,
    )


def pitch_metrics_to_dict(p: Optional[PitchMetrics]) -> Optional[dict]:
    """Plain JSON-friendly dict for the WebSocket payload."""
    return asdict(p) if p is not None else None
