"""
WebSocket server — streams pipeline events to the browser dashboard.

Messages sent to clients:
  { "type": "status",      "state": "armed"|"processing"|"idle", ... }
  { "type": "measurement", "exitVelocity": 95.2, "launchAngle": 14.3, ... }
  { "type": "audio_level", "rms": 0.12, "peak": 0.31, "threshold": 0.40 }
  { "type": "error",       "message": "..." }

Messages received from clients:
  { "type": "arm" }
  { "type": "disarm" }
  { "type": "reset" }
  { "type": "set_threshold", "value": 0.28 }
"""

import asyncio
import json
import logging
from typing import Any, Dict, Optional, Set

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
        self._threshold_cb = None   # called with float when browser sets a new threshold

    def set_callbacks(self, arm=None, disarm=None, reset=None, set_threshold=None) -> None:
        self._arm_cb        = arm
        self._disarm_cb     = disarm
        self._reset_cb      = reset
        self._threshold_cb  = set_threshold

    async def _handler(self, ws: "WebSocketServerProtocol") -> None:
        self._clients.add(ws)
        log.info("Client connected: %s", ws.remote_address)
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                t = msg.get("type")
                if   t == "arm"    and self._arm_cb:       self._arm_cb()
                elif t == "disarm" and self._disarm_cb:    self._disarm_cb()
                elif t == "reset"  and self._reset_cb:     self._reset_cb()
                elif t == "set_threshold" and self._threshold_cb:
                    try:
                        self._threshold_cb(float(msg["value"]))
                    except (KeyError, ValueError):
                        pass

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

    async def stream_audio_levels(self, audio) -> None:
        """Send audio RMS/peak/threshold to clients at ~10 Hz while running."""
        while True:
            await asyncio.sleep(0.1)
            if not self._clients or audio is None:
                continue
            await self._broadcast_async(json.dumps({
                "type":      "audio_level",
                "rms":       round(audio.current_rms, 4),
                "peak":      round(audio.peak_rms, 4),
                "threshold": round(audio.threshold, 4),
            }))

    async def stream_health(self) -> None:
        """Broadcast Pi vitals every 5 s while clients are connected."""
        while True:
            await asyncio.sleep(5)
            if not self._clients:
                continue
            h = read_health()
            await self._broadcast_async(json.dumps({
                "type":        "health",
                "cpuTempC":    round(h.cpu_temp_c, 1),
                "memUsedMb":   round(h.mem_used_mb, 0),
                "memTotalMb":  round(h.mem_total_mb, 0),
                "loadAvg1m":   round(h.load_avg_1m, 2),
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
