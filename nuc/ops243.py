"""
OmniPreSense OPS243-C-FC-RP radar driver for OVLM.

Hardware connection
-------------------
  USB-A cable: OPS243 → NUC USB port
  Linux device: /dev/ttyACM0  (or /dev/ttyACM1 if cameras claimed ACM0)
  Windows:      COM5 (check Device Manager → Ports)

The OPS243-C-FC-RP emits ASCII lines over a USB serial port at 9600 baud.
Each line is one of:
  {speed_mps}           — Doppler speed (negative = approaching = pitch inbound)
  {speed_mps},{range_m} — Doppler + FMCW range (when FMCW enabled)

Negative speed  → ball moving toward the sensor (pitch reading).
Positive speed  → ball moving away from the sensor (exit velocity reading).

This driver:
  - Sends startup commands to configure units, filters, and FMCW mode.
  - Classifies each reading as pitch_speed or exit_velocity based on direction
    and a configurable minimum speed threshold.
  - Exposes latest_pitch_mph(), latest_ev_mph(), latest_range_m().
  - Fires an optional trigger callback when a fast outbound ball is detected
    (mirrors the IWR6843Reader API so pipeline.py can treat them the same).

Usage
-----
  reader = OPS243Reader()
  reader.start()
  reader.set_trigger_callback(lambda speed_mph, range_m: ...)
  ...
  reader.stop()
"""

import logging
import re
import threading
import time
from typing import Callable, Optional

import config as cfg

log = logging.getLogger(__name__)

try:
    import serial
    SERIAL_AVAILABLE = True
except ImportError:
    SERIAL_AVAILABLE = False

MPS_TO_MPH = 2.23694

# Regex: optional sign, digits, optional decimal  (captures both "12.3" and "-12.3")
_SPEED_RE  = re.compile(r'^([+-]?\d+(?:\.\d+)?),?([+-]?\d+(?:\.\d+)?)?')

TriggerCallback = Callable[[float, Optional[float]], None]  # (speed_mph, range_m)


class OPS243Reader:
    """ASCII serial driver for the OPS243-C-FC-RP (Doppler + FMCW variant)."""

    def __init__(
        self,
        port:        str   = cfg.OPS243_PORT,
        baud:        int   = cfg.OPS243_BAUD,
        min_pitch:   float = cfg.OPS243_MIN_PITCH_MPS,
        min_ev:      float = cfg.OPS243_MIN_EV_MPS,
        debounce_s:  float = cfg.AUDIO_DEBOUNCE_S,
    ) -> None:
        self._port       = port
        self._baud       = baud
        self._min_pitch  = min_pitch   # m/s inbound threshold (negative dir)
        self._min_ev     = min_ev      # m/s outbound threshold (positive dir)
        self._debounce   = debounce_s

        self._running    = False
        self._thread: Optional[threading.Thread] = None
        self._trigger_cb: Optional[TriggerCallback] = None
        self._last_trigger = 0.0

        self._lock          = threading.Lock()
        self._pitch_mps:  Optional[float] = None   # last inbound speed (m/s)
        self._ev_mps:     Optional[float] = None   # last outbound speed (m/s)
        self._range_m:    Optional[float] = None   # last FMCW range (m)

    # ── Public API ─────────────────────────────────────────────────────────────

    def set_trigger_callback(self, cb: TriggerCallback) -> None:
        """Fires on each outbound detection above min_ev (exit velocity event)."""
        self._trigger_cb = cb

    def latest_pitch_mph(self) -> Optional[float]:
        with self._lock:
            return None if self._pitch_mps is None else self._pitch_mps * MPS_TO_MPH

    def latest_ev_mph(self) -> Optional[float]:
        with self._lock:
            return None if self._ev_mps is None else self._ev_mps * MPS_TO_MPH

    def latest_range_m(self) -> Optional[float]:
        with self._lock:
            return self._range_m

    def clear(self) -> None:
        """Reset stored readings — call after a measurement is consumed."""
        with self._lock:
            self._pitch_mps = None
            self._ev_mps    = None
            self._range_m   = None

    def start(self) -> None:
        if not SERIAL_AVAILABLE:
            raise RuntimeError("pyserial not installed — run: pip install pyserial")
        self._running = True
        self._thread = threading.Thread(
            target=self._read_loop, daemon=True, name="ops243-reader"
        )
        self._thread.start()
        log.info("OPS243 reader started on %s", self._port)

    def stop(self) -> None:
        self._running = False

    # ── Serial reader loop ─────────────────────────────────────────────────────

    def _read_loop(self) -> None:
        try:
            with serial.Serial(self._port, self._baud, timeout=0.1) as port:
                self._configure(port)
                while self._running:
                    line = port.readline().decode('ascii', errors='ignore').strip()
                    if line:
                        self._parse(line)
        except serial.SerialException as exc:
            log.error("OPS243 serial error: %s", exc)
        finally:
            log.info("OPS243 reader loop exited.")

    def _configure(self, port: "serial.Serial") -> None:
        """Send startup commands to the OPS243."""
        cmds = [
            b'S>',    # stop any ongoing output first
            b'UI>',   # units: m/s  (I = SI)
            b'R>',    # continuous speed reporting
            b'F>',    # enable FMCW range output (C-FC variant)
            b'A2>',   # 2-sample averaging — balance speed vs. noise
        ]
        for cmd in cmds:
            port.write(cmd)
            time.sleep(0.05)
        log.info("OPS243 configured.")

    def _parse(self, line: str) -> None:
        m = _SPEED_RE.match(line)
        if not m:
            return

        try:
            speed_mps = float(m.group(1))
        except (TypeError, ValueError):
            return

        range_m: Optional[float] = None
        if m.group(2):
            try:
                range_m = float(m.group(2))
            except ValueError:
                pass

        # Negative = ball approaching sensor (pitched ball coming in)
        # Positive = ball moving away from sensor (batted ball going out)
        if speed_mps < -self._min_pitch:
            with self._lock:
                self._pitch_mps = abs(speed_mps)
                if range_m is not None:
                    self._range_m = range_m
            log.debug("Pitch: %.1f mph", abs(speed_mps) * MPS_TO_MPH)

        elif speed_mps > self._min_ev:
            with self._lock:
                self._ev_mps  = speed_mps
                if range_m is not None:
                    self._range_m = range_m
            ev_mph = speed_mps * MPS_TO_MPH
            log.debug("EV: %.1f mph  range: %s m",
                      ev_mph, f"{range_m:.1f}" if range_m else "—")
            self._maybe_trigger(ev_mph, range_m)

    def _maybe_trigger(self, ev_mph: float, range_m: Optional[float]) -> None:
        if not self._trigger_cb:
            return
        now = time.monotonic()
        if now - self._last_trigger >= self._debounce:
            self._last_trigger = now
            self._trigger_cb(ev_mph, range_m)
