"""
Kalman filter trajectory smoothing + launch metric extraction.

State vector: [x, y, z, vx, vy, vz]
Observation:  [x, y, z]
Process model: constant velocity + gravity + linear drag
"""

import math
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import numpy as np

import config
from triangulate import Point3D

M_S_TO_MPH = 2.23694

# Pre-computed drag coefficient  (1/2 * rho * Cd * A / m)
_BALL_AREA = math.pi * (config.BALL_DIAMETER_M / 2) ** 2
DRAG_K = (
    0.5 * config.AIR_DENSITY * config.DRAG_COEFF * _BALL_AREA / config.BALL_MASS_KG
)


@dataclass
class LaunchMetrics:
    exit_velocity_mph: float
    launch_angle_deg: float
    spray_angle_deg: float
    fit_residual_mm: float
    processing_latency_ms: float
    trajectory: List[Point3D] = field(default_factory=list)


class TrajectoryFitter:
    """
    Runs a Kalman filter over an ordered list of 3D points and returns
    launch metrics extracted from the initial velocity estimate.
    """

    def fit(self, points: List[Point3D], latency_ms: float) -> Optional[LaunchMetrics]:
        if len(points) < 3:
            return None

        points = sorted(points, key=lambda p: p.timestamp)

        # ── Initialise from first two points ─────────────────────────────────
        dt0 = points[1].timestamp - points[0].timestamp
        if dt0 <= 0:
            dt0 = 1.0 / config.FRAMERATE

        p0 = points[0]
        p1 = points[1]
        state = np.array([
            p0.x, p0.y, p0.z,
            (p1.x - p0.x) / dt0,
            (p1.y - p0.y) / dt0,
            (p1.z - p0.z) / dt0,
        ], dtype=np.float64)

        P = np.eye(6) * 0.1
        Q = np.diag([1e-4, 1e-4, 1e-4, 0.1, 0.1, 0.1])
        R_obs = (0.005 ** 2) * np.eye(3)   # ~5 mm triangulation noise
        H = np.hstack([np.eye(3), np.zeros((3, 3))])

        initial_velocity = state[3:6].copy()
        smoothed: List[Point3D] = [p0]
        sum_residual = 0.0

        for i in range(1, len(points)):
            dt = points[i].timestamp - points[i - 1].timestamp
            if dt <= 0:
                dt = 1.0 / config.FRAMERATE

            vx, vy, vz = state[3], state[4], state[5]
            speed = math.sqrt(vx ** 2 + vy ** 2 + vz ** 2) + 1e-9
            ax = -DRAG_K * speed * vx
            ay = -config.GRAVITY_M_S2 - DRAG_K * speed * vy
            az = -DRAG_K * speed * vz

            # State transition matrix F
            F = np.eye(6)
            F[0, 3] = dt; F[1, 4] = dt; F[2, 5] = dt

            # Predict
            pred = np.array([
                state[0] + vx * dt + 0.5 * ax * dt ** 2,
                state[1] + vy * dt + 0.5 * ay * dt ** 2,
                state[2] + vz * dt + 0.5 * az * dt ** 2,
                vx + ax * dt,
                vy + ay * dt,
                vz + az * dt,
            ])
            P = F @ P @ F.T + Q

            # Update
            z_obs = np.array([points[i].x, points[i].y, points[i].z])
            innov = z_obs - H @ pred
            S = H @ P @ H.T + R_obs
            K = P @ H.T @ np.linalg.inv(S)
            state = pred + K @ innov
            P = (np.eye(6) - K @ H) @ P

            sum_residual += np.linalg.norm(innov)
            smoothed.append(Point3D(
                x=float(state[0]),
                y=float(state[1]),
                z=float(state[2]),
                timestamp=points[i].timestamp,
            ))

        # ── Extract launch metrics from initial velocity ───────────────────
        vx0, vy0, vz0 = initial_velocity
        horiz_speed = math.sqrt(vx0 ** 2 + vz0 ** 2)
        total_speed  = math.sqrt(vx0 ** 2 + vy0 ** 2 + vz0 ** 2)

        exit_vel_mph  = total_speed * M_S_TO_MPH
        launch_angle  = math.degrees(math.atan2(vy0, horiz_speed))
        spray_angle   = math.degrees(math.atan2(vx0, vz0))
        residual_mm   = (sum_residual / len(points)) * 1000.0

        # Filter: only keep points travelling toward pitcher (z ≥ 0)
        smoothed = [p for p in smoothed if p.z >= 0]

        return LaunchMetrics(
            exit_velocity_mph=round(exit_vel_mph, 1),
            launch_angle_deg=round(launch_angle, 1),
            spray_angle_deg=round(spray_angle, 1),
            fit_residual_mm=round(residual_mm, 2),
            processing_latency_ms=round(latency_ms, 1),
            trajectory=smoothed,
        )
