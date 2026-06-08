"""
TI IWR6843ISK 4D radar reader for OVLM.

Connects to the radar's two USB serial ports, sends the configuration,
then parses the binary mmWave Out-of-Box demo frame stream.

Frame format (TI mmWave SDK 3.x OOB demo):
  Frame header  — 40 bytes
  TLV type 1    — detected point cloud: (x, y, z, vel) float32 × N points
  TLV type 7    — side info: (snr, noise) uint16 × N points  [optional]

All positions in metres, velocity in m/s (radial; negative = approaching).

Usage:
  reader = IWR6843Reader(config_port='/dev/ttyUSB0', data_port='/dev/ttyUSB1')
  reader.start()
  reader.set_trigger_callback(lambda pts: ...)   # fires when a fast ball is seen
  ...
  reader.stop()

  # Or standalone config flash only:
  python radar.py --config-only
"""

import argparse
import logging
import os
import struct
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, List, Optional

import config as cfg

log = logging.getLogger(__name__)

try:
    import serial
    SERIAL_AVAILABLE = True
except ImportError:
    SERIAL_AVAILABLE = False

# ── Protocol constants ────────────────────────────────────────────────────────
MAGIC = b'\x02\x01\x04\x03\x06\x05\x08\x07'
FRAME_HEADER_LEN = 40   # bytes (TI SDK 3.x OOB)
TLV_HEADER_LEN   = 8    # bytes

TLV_DETECTED_POINTS = 1
TLV_SIDE_INFO       = 7

# Each detected point: x, y, z (m), velocity (m/s) — four float32s
POINT_BYTES = 16

# ── Data types ────────────────────────────────────────────────────────────────
@dataclass
class RadarPoint:
    x:     float   # m, +x = sensor right
    y:     float   # m, +y = sensor forward (toward pitcher)
    z:     float   # m, +z = sensor up
    vel:   float   # m/s, radial Doppler (negative = ball approaching sensor)
    snr:   float = 0.0   # dB, filled from TLV type 7 if present
    noise: float = 0.0   # dB

@dataclass
class RadarFrame:
    frame_number:  int
    num_detected:  int
    points:        List[RadarPoint] = field(default_factory=list)


TriggerCallback = Callable[[RadarPoint], None]


# ── Reader ────────────────────────────────────────────────────────────────────
class IWR6843Reader:
    def __init__(
        self,
        config_port: str = cfg.RADAR_CONFIG_PORT,
        data_port:   str = cfg.RADAR_DATA_PORT,
        config_file: str = cfg.RADAR_CONFIG_FILE,
    ) -> None:
        self._config_port  = config_port
        self._data_port    = data_port
        self._config_file  = config_file

        self._running      = False
        self._thread: Optional[threading.Thread] = None
        self._trigger_cb:  Optional[TriggerCallback] = None
        self._last_trigger = 0.0

        # Latest frame — accessed from the pipeline thread via latest_frame()
        self._lock  = threading.Lock()
        self._frame: Optional[RadarFrame] = None

    # ── Public API ────────────────────────────────────────────────────────────
    def set_trigger_callback(self, cb: TriggerCallback) -> None:
        """Called when a ball-speed detection crosses RADAR_TRIGGER_VELOCITY_MPS."""
        self._trigger_cb = cb

    def latest_frame(self) -> Optional[RadarFrame]:
        with self._lock:
            return self._frame

    def start(self) -> None:
        if not SERIAL_AVAILABLE:
            raise RuntimeError(
                "pyserial not installed — run: pip install pyserial"
            )
        self._send_config()
        self._running = True
        self._thread = threading.Thread(target=self._read_loop, daemon=True,
                                        name="radar-reader")
        self._thread.start()
        log.info("IWR6843 reader started (data port %s)", self._data_port)

    def stop(self) -> None:
        self._running = False

    # ── Config upload ─────────────────────────────────────────────────────────
    def _send_config(self) -> None:
        if not os.path.exists(self._config_file):
            raise FileNotFoundError(
                f"Radar config not found: {self._config_file}"
            )

        log.info("Sending radar config via %s …", self._config_port)
        with serial.Serial(self._config_port, cfg.RADAR_CONFIG_BAUD,
                           timeout=1) as port:
            for raw_line in open(self._config_file):
                line = raw_line.strip()
                if not line or line.startswith('%'):
                    continue
                port.write((line + '\n').encode())
                time.sleep(0.02)   # radar CLI needs a short gap between commands

                # Drain response — look for 'Done' or error
                resp = b''
                deadline = time.monotonic() + 0.5
                while time.monotonic() < deadline:
                    resp += port.read(port.in_waiting or 1)
                    if b'Done' in resp or b'Error' in resp:
                        break
                if b'Error' in resp:
                    log.warning("Radar config warning on '%s': %s",
                                line, resp.decode(errors='replace').strip())

        log.info("Radar config sent.")

    # ── Frame reader loop ─────────────────────────────────────────────────────
    def _read_loop(self) -> None:
        try:
            with serial.Serial(self._data_port, cfg.RADAR_DATA_BAUD,
                               timeout=0.1) as port:
                buf = b''
                while self._running:
                    buf += port.read(4096)
                    # Sync to magic word
                    idx = buf.find(MAGIC)
                    if idx == -1:
                        buf = buf[-len(MAGIC):]   # keep tail in case magic straddles reads
                        continue
                    buf = buf[idx:]

                    if len(buf) < FRAME_HEADER_LEN:
                        continue

                    frame = self._parse_frame(buf)
                    if frame is None:
                        buf = buf[len(MAGIC):]    # skip bad magic and resync
                        continue

                    total_len = struct.unpack_from('<I', buf, 12)[0]
                    if len(buf) < total_len:
                        continue                   # wait for rest of frame

                    buf = buf[total_len:]          # consume exactly one frame

                    with self._lock:
                        self._frame = frame

                    self._check_trigger(frame)

        except serial.SerialException as exc:
            log.error("Radar serial error: %s", exc)
        finally:
            log.info("Radar reader loop exited.")

    def _parse_frame(self, buf: bytes) -> Optional[RadarFrame]:
        if buf[:len(MAGIC)] != MAGIC:
            return None
        if len(buf) < FRAME_HEADER_LEN:
            return None

        # Frame header layout (40 bytes):
        # 8B magic | 4B version | 4B totalLen | 4B platform | 4B frameNum
        # 4B cpuCycles | 4B numDetected | 4B numTLVs | 4B subFrameNum
        try:
            (_, version, total_len, platform,
             frame_num, cpu_cycles,
             num_detected, num_tlvs, subframe) = struct.unpack_from(
                '<8sIIIIIIII', buf, 0
            )
        except struct.error:
            return None

        if total_len > len(buf) or total_len < FRAME_HEADER_LEN:
            return None

        frame = RadarFrame(frame_number=frame_num, num_detected=num_detected)
        points: List[RadarPoint] = []
        side_info: List[tuple] = []

        offset = FRAME_HEADER_LEN
        for _ in range(num_tlvs):
            if offset + TLV_HEADER_LEN > total_len:
                break
            tlv_type, tlv_len = struct.unpack_from('<II', buf, offset)
            offset += TLV_HEADER_LEN

            if offset + tlv_len > total_len:
                break

            if tlv_type == TLV_DETECTED_POINTS:
                n = tlv_len // POINT_BYTES
                for i in range(n):
                    x, y, z, vel = struct.unpack_from(
                        '<ffff', buf, offset + i * POINT_BYTES
                    )
                    points.append(RadarPoint(x=x, y=y, z=z, vel=vel))

            elif tlv_type == TLV_SIDE_INFO:
                n = tlv_len // 4
                for i in range(n):
                    snr, noise = struct.unpack_from('<HH', buf, offset + i * 4)
                    side_info.append((snr / 10.0, noise / 10.0))   # 0.1 dB steps

            offset += tlv_len

        # Attach side-info SNR/noise to points
        for i, pt in enumerate(points):
            if i < len(side_info):
                pt.snr, pt.noise = side_info[i]

        frame.points = points
        return frame

    def _check_trigger(self, frame: RadarFrame) -> None:
        if not self._trigger_cb:
            return
        threshold = cfg.RADAR_TRIGGER_VELOCITY_MPS
        debounce  = cfg.AUDIO_DEBOUNCE_S   # reuse same debounce window
        now = time.monotonic()

        for pt in frame.points:
            # Ball approaching the radar: negative Doppler; leaving: positive.
            # We care about the magnitude.
            if abs(pt.vel) >= threshold and pt.snr >= cfg.RADAR_MIN_SNR_DB:
                if now - self._last_trigger >= debounce:
                    self._last_trigger = now
                    log.info(
                        "Radar trigger: vel=%.1f m/s (%.0f mph)  "
                        "pos=(%.2f, %.2f, %.2f)  snr=%.1f dB",
                        pt.vel, abs(pt.vel) * 2.237,
                        pt.x, pt.y, pt.z, pt.snr,
                    )
                    self._trigger_cb(pt)
                    return   # one trigger per frame maximum


# ── CLI helper ────────────────────────────────────────────────────────────────
def _cli() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
    )
    parser = argparse.ArgumentParser(description="IWR6843ISK radar utility")
    parser.add_argument('--config-only', action='store_true',
                        help='Send config and exit (no streaming)')
    parser.add_argument('--config-port', default=cfg.RADAR_CONFIG_PORT)
    parser.add_argument('--data-port',   default=cfg.RADAR_DATA_PORT)
    args = parser.parse_args()

    reader = IWR6843Reader(args.config_port, args.data_port)
    reader._send_config()

    if args.config_only:
        print("Config sent. Done.")
        return

    def on_trigger(pt: RadarPoint) -> None:
        print(f"TRIGGER: {abs(pt.vel)*2.237:.0f} mph  "
              f"pos=({pt.x:.2f}, {pt.y:.2f}, {pt.z:.2f})  snr={pt.snr:.1f} dB")

    reader.set_trigger_callback(on_trigger)
    reader.start()

    print("Streaming radar data. Press Ctrl+C to stop.")
    try:
        while True:
            time.sleep(0.5)
            frame = reader.latest_frame()
            if frame and frame.points:
                best = max(frame.points, key=lambda p: abs(p.vel))
                print(f"Frame {frame.frame_number}: {len(frame.points)} pts  "
                      f"max_vel={abs(best.vel):.2f} m/s "
                      f"({abs(best.vel)*2.237:.0f} mph)  snr={best.snr:.1f} dB")
    except KeyboardInterrupt:
        reader.stop()


if __name__ == '__main__':
    _cli()
