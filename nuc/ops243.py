"""
OmniPreSense OPS243-C-FC-RP radar driver for OVLM — SDK edition.

Uses the official `omnipresense` Python library for:
  • Hardware cosine correction — compensates for angled mounting so 90 mph
    no longer reads as 63 mph (v_radar = v_actual × cos(θ) at angle θ)
  • Proper speed filtering via set_speed_filter() — replaces the broken BL30
    raw command (BL is a blank-reporting mode flag, NOT a speed threshold)
  • HZ_20000 sampling rate — max 139 mph, covers all baseball speeds

Noise rejection strategy:
  The OPS243 emits one reading per detected Doppler peak (the SDK deduplicates
  internally).  Because each detection = 1 reading, burst-counting doesn't work.
  Instead we rely on:
    1. Hardware speed gate  — only 35–130 mph passes the sensor
    2. Hardware magnitude gate  — require signal > OPS243_MIN_MAGNITUDE
    3. Direction classification  — APPROACHING = pitch, RECEDING = EV
    4. Per-direction speed floors  — pitch ≥ 45 mph, EV ≥ 35 mph
    5. EV peak window  — peak over 5 s so the highest true reading dominates

Public API is identical to the original OPS243Reader so main.py / server.py
require no changes.
"""

import logging
import math
import threading
import time
from collections import deque
from typing import Callable, Deque, Optional, Tuple

import config as cfg

log = logging.getLogger(__name__)

try:
    from omnipresense import OPS243C_CombinedRadar, Direction, SamplingRate, Units
    OMNIPRESENSE_AVAILABLE = True
except ImportError:
    OMNIPRESENSE_AVAILABLE = False

MPS_TO_MPH = 2.23694

_EV_PEAK_WINDOW_S = 5.0   # hold EV readings for 5 s so the peak stays visible

TriggerCallback      = Callable[[float, Optional[float]], None]   # (ev_mph, range_m)
PitchTriggerCallback = Callable[[float], None]                    # (pitch_mph,)


class OPS243Reader:
    """OPS243-C radar driver using the official omnipresense SDK."""

    def __init__(
        self,
        port:       str   = cfg.OPS243_PORT,
        min_pitch:  float = cfg.OPS243_MIN_PITCH_MPS,   # m/s — converted below
        min_ev:     float = cfg.OPS243_MIN_EV_MPS,      # m/s — converted below
        debounce_s: float = cfg.AUDIO_DEBOUNCE_S,
    ) -> None:
        self._port           = port
        self._min_pitch_mph  = min_pitch * MPS_TO_MPH   # 45 mph default
        self._min_ev_mph     = min_ev    * MPS_TO_MPH   # 35 mph default
        self._debounce       = debounce_s

        self._trigger_cb: Optional[TriggerCallback] = None
        self._last_trigger       = 0.0
        self._pitch_trigger_cb: Optional[PitchTriggerCallback] = None
        self._last_pitch_trigger = 0.0

        self._lock           = threading.Lock()
        self._pitch_mph:  Optional[float] = None
        self._ev_mph:     Optional[float] = None
        self._ev_range_m: Optional[float] = None   # range from EV (RECEDING) readings only
        self._ev_buffer:  Deque[Tuple[float, float]] = deque()   # (ts, mph)

        self._radar: Optional["OPS243C_CombinedRadar"] = None

        # Bore geometry for cosine correction.
        # Pitch travels ≈ -Z in world frame; |dot(bore, (0,0,-1))| = |bore_z|.
        # EV direction varies per hit — pipeline applies exact correction from camera.
        bu = getattr(cfg, 'OPS243_BORE_UNIT', (0.0, 0.0, 1.0))
        self._bore_unit: Tuple[float, float, float] = (
            float(bu[0]), float(bu[1]), float(bu[2])
        )
        self._pitch_cos = abs(self._bore_unit[2])
        # Conservative raw EV floor: real EV ≥ min_ev at up to 70° off bore
        self._min_ev_raw_mph = self._min_ev_mph * math.cos(math.radians(70))

    # ── Public API ─────────────────────────────────────────────────────────────

    def set_trigger_callback(self, cb: TriggerCallback) -> None:
        self._trigger_cb = cb

    def set_pitch_trigger_callback(self, cb: PitchTriggerCallback) -> None:
        self._pitch_trigger_cb = cb

    def latest_pitch_mph(self) -> Optional[float]:
        with self._lock:
            return self._pitch_mph

    def latest_ev_mph(self) -> Optional[float]:
        with self._lock:
            return self._ev_mph

    def peak_ev_mph(self) -> Optional[float]:
        """Peak EV from the rolling window — stays visible for _EV_PEAK_WINDOW_S."""
        now    = time.monotonic()
        cutoff = now - _EV_PEAK_WINDOW_S
        with self._lock:
            recent = [ev for ts, ev in self._ev_buffer if ts >= cutoff]
        return max(recent) if recent else None

    def latest_range_m(self) -> Optional[float]:
        with self._lock:
            return self._ev_range_m

    def clear(self) -> None:
        with self._lock:
            self._pitch_mph  = None
            self._ev_mph     = None
            self._ev_range_m = None
            self._ev_buffer.clear()

    def set_bore_unit(self, bore_unit: Tuple[float, float, float]) -> None:
        """Update bore geometry at runtime (called after calibration saves new radar position)."""
        self._bore_unit  = (float(bore_unit[0]), float(bore_unit[1]), float(bore_unit[2]))
        self._pitch_cos  = abs(self._bore_unit[2])
        self._min_ev_raw_mph = self._min_ev_mph * math.cos(math.radians(70))
        log.info("OPS243 bore updated: (%.3f, %.3f, %.3f)  pitch_cos=%.3f",
                 *self._bore_unit, self._pitch_cos)

    def start(self) -> None:
        if not OMNIPRESENSE_AVAILABLE:
            raise RuntimeError(
                "omnipresense not installed — run: pip install omnipresense"
            )
        self._radar = OPS243C_CombinedRadar(port=self._port)
        if not self._radar.open():
            raise RuntimeError(f"OPS243 failed to open on {self._port}")
        self._configure()
        self._radar.start_streaming(self._on_reading)
        log.info("OPS243 started on %s", self._port)

    def stop(self) -> None:
        if self._radar is not None:
            try:
                self._radar.stop_streaming()
                self._radar.close()
            except Exception:
                pass
            self._radar = None

    # ── Configuration ──────────────────────────────────────────────────────────

    def _configure(self) -> None:
        r = self._radar

        r.set_units(Units.MILES_PER_HOUR)

        # HZ_20000: max 139 mph — covers all baseball speeds without aliasing
        r.set_sampling_rate(SamplingRate.HZ_20000)

        # Magnitude gate
        min_mag = getattr(cfg, "OPS243_MIN_MAGNITUDE", 5)
        r.set_magnitude_threshold(threshold=min_mag, doppler=True)

        # Per-shot cosine correction is applied in software using the camera-derived
        # velocity vector (pipeline.py). Disable hardware correction so _on_reading
        # receives raw radial speeds; pitch is corrected here using the bore geometry.
        r.disable_cosine_correction()

        # Speed filter runs on raw (uncorrected) values. Floor set low enough that
        # real balls aren't rejected even at steep bore angles (~70°):
        # 35 mph EV × cos(70°) ≈ 12 mph raw — 10 mph gives a safe margin.
        r.set_speed_filter(min_speed=10.0, max_speed=150.0)

        r.enable_peak_speed_averaging(enable=True)

        log.info(
            "OPS243 configured: raw 10–150 mph, magnitude≥%d, HZ_20000  "
            "bore=(%.3f, %.3f, %.3f)  pitch_cos=%.3f",
            min_mag, *self._bore_unit, self._pitch_cos,
        )

    # ── Streaming callback ─────────────────────────────────────────────────────

    def _on_reading(self, reading) -> None:
        """Called by the omnipresense reader thread for each radar reading.

        Direction convention:
          APPROACHING (+) — object moving toward the sensor  → inbound pitch
          RECEDING    (−) — object moving away from the sensor → exit velocity

        Speeds are raw radial values (SDK cosine correction disabled). Pitch speed
        is corrected here using the bore geometry (pitch direction ≈ −Z is fixed).
        EV is stored raw — pipeline.py applies the exact per-shot correction using
        the camera-derived 3-D velocity vector.
        """
        speed     = reading.speed
        direction = reading.direction
        range_m   = reading.range_m

        if speed is None or direction is None:
            return

        if direction == Direction.APPROACHING:
            if self._pitch_cos < 0.1:
                return   # bore nearly perpendicular to pitch — correction unreliable
            corrected = speed / self._pitch_cos
            if corrected > 130.0:
                return   # above physical ceiling after correction — noise
            if corrected >= self._min_pitch_mph:
                with self._lock:
                    self._pitch_mph = corrected
                log.info("OPS243 pitch  %.1f mph (raw %.1f)%s",
                         corrected, speed,
                         f"  range={range_m:.1f} m" if range_m is not None else "")
                self._maybe_pitch_trigger(corrected)

        elif direction == Direction.RECEDING and speed >= self._min_ev_raw_mph:
            # Store raw — pipeline applies exact per-shot cosine from camera velocity.
            # Pass an approximate corrected value to the trigger callback for logging.
            ev_cos_approx = abs(self._bore_unit[2])
            approx = speed / ev_cos_approx if ev_cos_approx > 0.1 else speed
            # Reject if the corrected estimate is still below the EV floor — this
            # catches human-movement noise (10–35 mph) that slips through the raw
            # floor because of the conservative 70° bore-angle safety margin.
            if approx < self._min_ev_mph:
                return
            now = time.monotonic()
            with self._lock:
                self._ev_mph = speed
                self._ev_buffer.append((now, speed))
                cutoff = now - _EV_PEAK_WINDOW_S
                while self._ev_buffer and self._ev_buffer[0][0] < cutoff:
                    self._ev_buffer.popleft()
                if range_m is not None:
                    self._ev_range_m = range_m
            log.info("OPS243 EV     raw %.1f (≈%.1f) mph%s",
                     speed, approx,
                     f"  range={range_m:.1f} m" if range_m is not None else "")
            self._maybe_trigger(approx, range_m)

    def _maybe_trigger(self, ev_mph: float, range_m: Optional[float]) -> None:
        if not self._trigger_cb:
            return
        now = time.monotonic()
        if now - self._last_trigger >= self._debounce:
            self._last_trigger = now
            self._trigger_cb(ev_mph, range_m)

    def _maybe_pitch_trigger(self, pitch_mph: float) -> None:
        if not self._pitch_trigger_cb:
            return
        now = time.monotonic()
        if now - self._last_pitch_trigger >= self._debounce:
            self._last_pitch_trigger = now
            self._pitch_trigger_cb(pitch_mph)
