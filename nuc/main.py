"""
OVLM — Open Vision Launch Monitor
Entry point for the Windows NUC pipeline.

Usage:
    python main.py [--no-audio] [--debug]
"""

import argparse
import asyncio
import logging
import signal
import sys
import time

import config
from audio_trigger import AudioTrigger
from capture import StereoCapturer
from frame_buffer import FrameBuffer
from pipeline import TrackingPipeline
from radar import IWR6843Reader
from server import PipelineServer


def main() -> None:
    parser = argparse.ArgumentParser(description="OVLM NUC pipeline")
    parser.add_argument("--no-audio", action="store_true",
                        help="Disable mic trigger (manual arm via browser)")
    parser.add_argument("--radar", action="store_true",
                        help="Enable TI IWR6843ISK radar (also triggers on ball detection)")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    log = logging.getLogger("main")

    server   = PipelineServer()

    # ── Radar (optional) ──────────────────────────────────────────────────────
    radar: IWR6843Reader | None = None
    if args.radar or config.RADAR_ENABLED:
        radar = IWR6843Reader()
        radar.start()
        log.info("IWR6843 radar started")

    pipeline = TrackingPipeline(server, radar=radar)
    buffer   = FrameBuffer(on_flush=pipeline.process)
    capturer = StereoCapturer(on_pair=buffer.push)

    armed = False

    def arm():
        nonlocal armed
        armed = True
        if not args.no_audio:
            audio.arm()
        server.broadcast({"type": "status", "state": "armed", "audioArmed": not args.no_audio})
        log.info("Armed")

    def disarm():
        nonlocal armed
        armed = False
        if not args.no_audio:
            audio.disarm()
        server.broadcast({"type": "status", "state": "idle", "audioArmed": False})
        log.info("Disarmed")

    def reset():
        buffer.clear()
        server.broadcast({"type": "status", "state": "armed"})
        log.info("Reset")

    if not args.no_audio:
        audio = AudioTrigger(on_trigger=lambda t: buffer.trigger(t) if armed else None)
        audio.start()
        log.info("Audio trigger started")
    else:
        audio = None

    # Radar trigger: fires the same buffer.trigger() path as audio.
    # buffer.trigger() expects a monotonic timestamp, not the radar velocity.
    if radar is not None:
        def _radar_trigger(pt) -> None:
            if armed:
                log.info("Radar trigger at %.1f mph", abs(pt.vel) * 2.23694)
                buffer.trigger(time.monotonic())
        radar.set_trigger_callback(_radar_trigger)

    def set_threshold(value: float) -> None:
        if audio is not None:
            audio.set_threshold(value)
            log.info("Audio threshold → %.3f", audio.threshold)

    server.set_callbacks(arm=arm, disarm=disarm, reset=reset, set_threshold=set_threshold)

    log.info("Starting stereo capture …")
    capturer.start()

    log.info("Ready. Connect browser to ws://localhost:%d", config.WS_PORT)
    server.broadcast({"type": "status", "state": "idle"})

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    def _shutdown(sig_name: str = "shutdown") -> None:
        log.info("Received %s — shutting down …", sig_name)
        loop.stop()

    # asyncio.loop.add_signal_handler is Unix-only; use signal.signal on Windows
    if sys.platform == "win32":
        signal.signal(signal.SIGINT,
                      lambda sig, frame: loop.call_soon_threadsafe(loop.stop))
    else:
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, lambda s=sig: _shutdown(signal.Signals(s).name))

    async def _run() -> None:
        await asyncio.gather(
            server.serve(),
            server.stream_audio_levels(audio),
            server.stream_health(),
        )

    try:
        loop.run_until_complete(_run())
    finally:
        capturer.stop()
        if audio:
            audio.stop()
        if radar:
            radar.stop()
        loop.close()
        log.info("Stopped.")


if __name__ == "__main__":
    main()
