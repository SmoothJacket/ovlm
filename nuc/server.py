"""
WebSocket server — streams pipeline events to the browser dashboard.

Messages sent to clients:
  { "type": "status",      "state": "armed"|"processing"|"idle", ... }
  { "type": "measurement", "exitVelocity": 95.2, "launchAngle": 14.3, ... }
  { "type": "audio_level", "rms": 0.12, "peak": 0.31, "threshold": 0.40 }
  { "type": "calibration", "state": "collecting"|"done"|"error", ... }
  { "type": "error",       "message": "..." }

Messages received from clients:
  { "type": "arm" }
  { "type": "disarm" }
  { "type": "reset" }
  { "type": "set_threshold", "value": 0.28 }
  { "type": "calibrate" }
"""

import asyncio
import base64
import json
import logging
from typing import Any, Callable, Dict, Optional, Set

try:
    import websockets
    from websockets.server import WebSocketServerProtocol
    WS_AVAILABLE = True
except ImportError:
    WS_AVAILABLE = False

import config
from health import read_health

log = logging.getLogger(__name__)


class PipelineServer:
    def __init__(self) -> None:
        self._clients:  Set[Any] = set()
        self._loop:     Optional[asyncio.AbstractEventLoop] = None
        self._arm_cb    = None
        self._disarm_cb = None
        self._reset_cb  = None
        self._trigger_cb          = None
        self._calibrate_cb        = None
        self._calib_manual_cb     = None
        self._set_session_mode_cb = None
        self._set_sub_session_cb  = None
        self._get_status_cb = None  # () -> dict  — called on each new connection

    def set_callbacks(self, arm=None, disarm=None, reset=None, trigger=None,
                      calibrate=None,
                      calib_manual=None, set_session_mode=None,
                      set_sub_session=None,
                      get_status=None) -> None:
        self._arm_cb              = arm
        self._disarm_cb           = disarm
        self._reset_cb            = reset
        self._trigger_cb          = trigger
        self._calibrate_cb        = calibrate
        self._calib_manual_cb     = calib_manual
        self._set_session_mode_cb = set_session_mode
        self._set_sub_session_cb  = set_sub_session
        self._get_status_cb       = get_status

    async def _handler(self, ws: "WebSocketServerProtocol") -> None:
        self._clients.add(ws)
        log.info("Client connected: %s", ws.remote_address)
        # Push current system state to the freshly connected browser.
        if self._get_status_cb:
            try:
                await ws.send(json.dumps(self._get_status_cb()))
            except Exception:
                pass
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                t = msg.get("type")
                if   t == "arm"     and self._arm_cb:      self._arm_cb()
                elif t == "disarm"  and self._disarm_cb:   self._disarm_cb()
                elif t == "reset"   and self._reset_cb:    self._reset_cb()
                elif t == "trigger" and self._trigger_cb:  self._trigger_cb()
                elif t == "calibrate" and self._calibrate_cb:
                    mode = msg.get("mode", "hitting")
                    self._calibrate_cb(mode)
                elif t == "calib_manual" and self._calib_manual_cb:
                    try:
                        self._calib_manual_cb(
                            msg["corners0"],
                            msg["corners1"],
                            float(msg.get("heightMm", 0.0)),
                            float(msg.get("distanceMm", 0.0)),
                            msg.get("mode", "hitting"),
                            float(msg.get("radarBehindMm", 0.0)),
                            float(msg.get("radarHeightMm", 0.0)),
                        )
                    except (KeyError, ValueError, TypeError):
                        pass
                elif t == "set_session_mode" and self._set_session_mode_cb:
                    mode = msg.get("mode")
                    if mode in ("hitting", "pitching"):
                        self._set_session_mode_cb(mode)
                elif t == "set_sub_session" and self._set_sub_session_cb:
                    sub = msg.get("subType")   # 'tee' | 'front_toss' | 'live_bp' | None
                    self._set_sub_session_cb(sub)

        except Exception:
            pass
        finally:
            self._clients.discard(ws)
            log.info("Client disconnected")

    def broadcast(self, payload: Dict[str, Any]) -> None:
        """Thread-safe broadcast to all connected browser clients."""
        if not self._clients or self._loop is None:
            return
        data = json.dumps(payload)
        asyncio.run_coroutine_threadsafe(self._broadcast_async(data), self._loop)

    async def _broadcast_async(self, data: str) -> None:
        if not self._clients:
            return
        await asyncio.gather(
            *(ws.send(data) for ws in list(self._clients)),
            return_exceptions=True,
        )

    async def stream_health(self, get_cam_fps=None) -> None:
        """Broadcast Pi vitals every 5 s while clients are connected."""
        while True:
            await asyncio.sleep(5)
            if not self._clients:
                continue
            h = read_health()
            payload: Dict[str, Any] = {
                "type":        "health",
                "cpuTempC":    round(h.cpu_temp_c, 1),
                "memUsedMb":   round(h.mem_used_mb, 0),
                "memTotalMb":  round(h.mem_total_mb, 0),
                "loadAvg1m":   round(h.load_avg_1m, 2),
            }
            if get_cam_fps is not None:
                fps0, fps1 = get_cam_fps()
                payload["cam0Fps"] = round(fps0)
                payload["cam1Fps"] = round(fps1)
            await self._broadcast_async(json.dumps(payload))

    async def stream_radar(self, get_ops243) -> None:
        """Broadcast OPS243 readings when a value changes meaningfully.
        Throttled to at most 1 Hz and requires ≥1 mph change to suppress
        the constant small-fluctuation noise the radar emits between events."""
        last = (None, None, None)   # (pitchMph, evMph, rangeM)
        last_sent = 0.0
        MIN_INTERVAL_S = 1.0
        MIN_DELTA_MPH  = 1.0
        while True:
            await asyncio.sleep(0.1)
            radar = get_ops243() if get_ops243 else None
            if radar is None or not self._clients:
                continue
            current = (
                radar.latest_pitch_mph(),
                radar.peak_ev_mph(),      # peak over 5 s window — stays visible after hit
                radar.latest_range_m(),
            )
            if current == last:
                continue
            # Require at least one field to change by MIN_DELTA_MPH
            changed = False
            for a, b in zip(current[:2], last[:2]):   # pitch and EV only (range is m)
                if (a is None) != (b is None):
                    changed = True
                    break
                if a is not None and b is not None and abs(a - b) >= MIN_DELTA_MPH:
                    changed = True
                    break
            now = asyncio.get_event_loop().time()
            if not changed and (now - last_sent) < MIN_INTERVAL_S:
                continue
            last = current
            last_sent = now
            await self._broadcast_async(json.dumps({
                "type":     "radar_status",
                "pitchMph": current[0],
                "evMph":    current[1],
                "rangeM":   current[2],
            }))

    async def stream_calib_frames(self, get_session) -> None:
        """Broadcast annotated preview frames at ~15 fps while a calib session is active."""
        while True:
            await asyncio.sleep(1 / 15)
            session = get_session()
            if session is None or not self._clients:
                continue
            try:
                j0, j1, f0, f1 = session.grab_annotated()
            except Exception:
                continue
            await self._broadcast_async(json.dumps({
                "type":         "calib_frame",
                "cam0":         base64.b64encode(j0).decode(),
                "cam1":         base64.b64encode(j1).decode(),
                "cornersFound": [f0, f1],
                "step":         session.step,
            }))

    async def serve(self) -> None:
        if not WS_AVAILABLE:
            raise RuntimeError("websockets is not installed. Run: pip install websockets")

        self._loop = asyncio.get_running_loop()
        log.info("WebSocket server listening on ws://%s:%d", config.WS_HOST, config.WS_PORT)
        async with websockets.serve(self._handler, config.WS_HOST, config.WS_PORT):
            try:
                await asyncio.get_running_loop().create_future()
            except asyncio.CancelledError:
                pass
