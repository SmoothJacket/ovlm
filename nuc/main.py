"""
OVLM — Open Vision Launch Monitor
Entry point for the NUC pipeline.

Usage:
    python main.py [--no-audio] [--ops243] [--radar] [--vision-trigger] [--spin-cam] [--debug]
"""

import argparse
import asyncio
import logging
import signal
import sys
import threading
import time

import config
from audio_trigger import AudioTrigger
from capture import SpinCapturer, StereoCapturer
from frame_buffer import FrameBuffer, SpinFrameRing
from pipeline import TrackingPipeline
from ops243 import OPS243Reader
from plate_calib import LiveCollector
from radar import IWR6843Reader
from server import PipelineServer
from vision_trigger import VisionTrigger


def main() -> None:
    parser = argparse.ArgumentParser(description="OVLM NUC pipeline")
    parser.add_argument("--no-audio", action="store_true",
                        help="Disable mic trigger (manual arm via browser)")
    parser.add_argument("--ops243", action="store_true",
                        help="Enable OPS243-C-FC-RP radar (pitch speed + EV + carry distance)")
    parser.add_argument("--radar", action="store_true",
                        help="Enable TI IWR6843ISK radar (also triggers on ball detection)")
    parser.add_argument("--spin-cam", action="store_true",
                        help="Enable the optional high-fps spin camera (config.SPIN_CAM_*)")
    parser.add_argument("--vision-trigger", action="store_true",
                        help="Camera-based ball-entering-frame trigger — stand-in for "
                             "radar until the IWR6843 is wired up")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    log = logging.getLogger("main")

    server = PipelineServer()

    # ── OPS243 radar (plug-and-play: pitch speed + EV + carry distance) ──────
    ops243: OPS243Reader | None = None
    if args.ops243 or config.OPS243_ENABLED:
        try:
            ops243 = OPS243Reader()
            ops243.start()
            log.info("OPS243 radar started on %s", config.OPS243_PORT)
        except Exception as exc:
            log.warning("OPS243 not available (%s) — continuing without it", exc)
            ops243 = None

    # ── TI IWR6843ISK radar (optional, binary mmWave) ─────────────────────────
    radar: IWR6843Reader | None = None
    if args.radar or config.RADAR_ENABLED:
        radar = IWR6843Reader()
        radar.start()
        log.info("IWR6843 radar started")

    # ── Spin camera (optional) ────────────────────────────────────────────────
    spin_ring: SpinFrameRing | None = None
    spin_cap:  SpinCapturer  | None = None
    if args.spin_cam or config.SPIN_CAM_ENABLED:
        spin_ring = SpinFrameRing()
        spin_cap  = SpinCapturer(on_frame=spin_ring.push)

    # ── Vision trigger (optional, camera-only stand-in for radar) ────────────
    vision: VisionTrigger | None = None
    if args.vision_trigger or config.VISION_TRIGGER_ENABLED:
        vision = VisionTrigger(on_trigger=lambda t: buffer.trigger(t) if armed else None)
        log.info("Vision trigger enabled (camera-based ball detection, stand-in for radar)")

    pipeline  = TrackingPipeline(server, radar=radar, ops243=ops243, spin_ring=spin_ring)
    buffer    = FrameBuffer(on_flush=pipeline.process)

    # ── Home-plate calibration (always-on preview + one-click collect) ────────
    # LiveCollector streams annotated frames to the browser at all times so the
    # calibration panel always shows live plate-detection overlays. Samples are
    # only accumulated after the user clicks "Calibrate".
    collector = LiveCollector()

    def _dispatch_pair(pair):
        buffer.push(pair)
        if vision is not None:
            vision.feed(pair.left)
        collector.feed(pair.left, pair.right)

    capturer = StereoCapturer(on_pair=_dispatch_pair)

    armed = False

    def arm():
        nonlocal armed
        armed = True
        if not args.no_audio:
            audio.arm()
        if vision is not None:
            vision.arm()
        server.broadcast({"type": "status", "state": "armed", "audioArmed": not args.no_audio})
        log.info("Armed")

    def disarm():
        nonlocal armed
        armed = False
        if not args.no_audio:
            audio.disarm()
        if vision is not None:
            vision.disarm()
        server.broadcast({"type": "status", "state": "idle", "audioArmed": False})
        log.info("Disarmed")

    def reset():
        buffer.clear()
        if spin_ring is not None:
            spin_ring.clear()
        if vision is not None:
            vision.reset_background()
        server.broadcast({"type": "status", "state": "armed"})
        log.info("Reset")

    if not args.no_audio:
        audio = AudioTrigger(on_trigger=lambda t: buffer.trigger(t) if armed else None)
        audio.start()
        log.info("Audio trigger started")
    else:
        audio = None

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

    def calibrate_home() -> None:
        if collector.collecting:
            return
        log.info("Starting home-plate calibration …")
        collector.start_collecting()
        server.broadcast({
            "type": "calibration", "state": "collecting",
            "progress": 0, "total": collector.frames,
        })
        threading.Thread(target=_finish_calibration, daemon=True).start()

    def _finish_calibration() -> None:
        deadline = time.monotonic() + 30.0
        last_broadcast = 0
        while not collector.done:
            time.sleep(0.15)
            now = time.monotonic()
            if now > deadline:
                collector.stop_collecting()
                server.broadcast({
                    "type": "calibration", "state": "error",
                    "message": f"Only {collector.count}/{collector.frames} samples in 30 s — "
                               "make sure the plate is fully visible in both cameras.",
                })
                return
            if now - last_broadcast >= 0.25 and collector.count > 0:
                server.broadcast({
                    "type": "calibration", "state": "collecting",
                    "progress": collector.count, "total": collector.frames,
                })
                last_broadcast = now

        collector.stop_collecting()
        result = collector.solve(config.CALIBRATION_FILE)
        if result is None:
            server.broadcast({"type": "calibration", "state": "error",
                              "message": "Calibration solve failed — see NUC console log."})
            return
        pipeline.reload_calibration()
        log.info("Calibration complete: baseline=%.1fmm rms=%.1fmm reproj=%.2fpx",
                 result["baselineMm"], result["rmsMm"], result["reprojPx"])
        server.broadcast({"type": "calibration", "state": "done", **result})

    server.set_callbacks(arm=arm, disarm=disarm, reset=reset,
                         set_threshold=set_threshold, calibrate=calibrate_home)

    log.info("Starting stereo capture …")
    capturer.start()

    if spin_cap is not None:
        if spin_cap.start():
            log.info("Spin camera started (index %d @ %d fps)",
                     config.SPIN_CAM_IDX, config.SPIN_CAM_FPS)
        else:
            log.warning("Spin camera not found at index %d — "
                        "falling back to stereo cam 0 for spin", config.SPIN_CAM_IDX)
            spin_cap = None

    log.info("Ready. Connect browser to ws://localhost:%d", config.WS_PORT)
    server.broadcast({"type": "status", "state": "idle"})

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    def _shutdown(sig_name: str = "shutdown") -> None:
        log.info("Received %s — shutting down …", sig_name)
        loop.stop()

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
            server.stream_calib_frames(lambda: collector),
        )

    try:
        loop.run_until_complete(_run())
    finally:
        capturer.stop()
        if spin_cap:
            spin_cap.stop()
        if audio:
            audio.stop()
        if ops243:
            ops243.stop()
        if radar:
            radar.stop()
        loop.close()
        log.info("Stopped.")


if __name__ == "__main__":
    main()
