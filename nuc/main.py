"""
OVLM — Open Vision Launch Monitor
Entry point for the NUC pipeline.

Usage:
    python main.py [--ops243] [--spin-cam] [--debug]
"""

import argparse
import asyncio
import logging
import shutil
import signal
import sys
import threading
import time

import config
from capture import SpinCapturer, StereoCapturer
from frame_buffer import FrameBuffer, SpinFrameRing
from pipeline import TrackingPipeline
from ops243 import OPS243Reader
from plate_calib import LiveCollector, solve_from_manual_corners
from server import PipelineServer


def main() -> None:
    parser = argparse.ArgumentParser(description="OVLM NUC pipeline")
    parser.add_argument("--ops243", action="store_true",
                        help="Enable OPS243-C-FC-RP radar (pitch speed + EV + carry distance)")
    parser.add_argument("--spin-cam", action="store_true",
                        help="Enable the optional high-fps spin camera (config.SPIN_CAM_*)")
    parser.add_argument("--no-cameras", action="store_true",
                        help="Skip camera initialisation — WebSocket server runs without hardware "
                             "(useful for UI development / testing on a machine with no cameras)")
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

    # ── Spin camera (optional) ────────────────────────────────────────────────
    spin_ring: SpinFrameRing | None = None
    spin_cap:  SpinCapturer  | None = None
    if args.spin_cam or config.SPIN_CAM_ENABLED:
        spin_ring = SpinFrameRing()
        spin_cap  = SpinCapturer(on_frame=spin_ring.push)

    # Tracks which hitting sub-session is active (tee / front_toss / live_bp).
    # Used to: (a) gate the pitch camera trigger, (b) suppress pitchVelocity on tee.
    active_sub = {"type": None}

    pipeline       = TrackingPipeline(server, ops243=ops243, spin_ring=spin_ring,
                                      get_sub_session=lambda: active_sub["type"])
    buffer         = FrameBuffer(on_flush=pipeline.process)

    # Separate buffer / pipeline for camera-measured pitch speed in non-tee
    # hitting sessions.  ops243=None so it doesn't touch radar state.
    pitch_pipeline = TrackingPipeline(server, ops243=None, spin_ring=None)
    pitch_buffer   = FrameBuffer(on_flush=pitch_pipeline.process)

    # ── Home-plate calibration (always-on preview + one-click collect) ────────
    # LiveCollector streams annotated frames to the browser at all times so the
    # calibration panel always shows live plate-detection overlays. Samples are
    # only accumulated after the user clicks "Calibrate".
    collector = LiveCollector()

    def _dispatch_pair(pair):
        buffer.push(pair)
        pitch_buffer.push(pair)
        collector.feed(pair.left, pair.right)

    capturer = StereoCapturer(on_pair=_dispatch_pair)

    armed = True   # start ready; radar trigger fires on any ball > min_ev threshold

    def arm():
        nonlocal armed
        armed = True
        server.broadcast({"type": "status", "state": "armed"})
        log.info("Armed")

    def disarm():
        nonlocal armed
        armed = False
        server.broadcast({"type": "status", "state": "idle"})
        log.info("Disarmed")

    def reset():
        buffer.clear()
        if spin_ring is not None:
            spin_ring.clear()
        server.broadcast({"type": "status", "state": "armed"})
        log.info("Reset")

    def manual_trigger() -> None:
        """Fire the pipeline NOW — used when no automatic trigger source
        (audio / radar / vision) is available. Operator clicks TRIGGER in the
        browser at the moment of contact and the buffer's ±HALF_WINDOW_S
        window around 'now' gets processed."""
        if not armed:
            log.warning("Manual trigger ignored — system not armed")
            return
        log.info("Manual trigger fired")
        buffer.trigger(time.monotonic())

    # OPS243 — every radar detection triggers the camera.
    #   RECEDING (EV)   → main buffer  (hit departure or pitch past the plate)
    #   APPROACHING     → pitch buffer in hitting mode; main buffer in pitching mode
    if ops243 is not None:
        def _ops_trigger(ev_mph: float, range_m) -> None:
            if armed:
                log.info("OPS243 EV trigger at %.1f mph%s",
                         ev_mph, f"  range={range_m:.1f} m" if range_m else "")
                buffer.trigger(time.monotonic())
        ops243.set_trigger_callback(_ops_trigger)

        def _ops_pitch_trigger(pitch_mph: float) -> None:
            if not armed:
                return
            if active_mode["mode"] == "pitching":
                log.info("OPS243 pitch trigger at %.1f mph", pitch_mph)
                buffer.trigger(time.monotonic())
            else:
                log.info("OPS243 pitch trigger (hitting) at %.1f mph", pitch_mph)
                pitch_buffer.trigger(time.monotonic())
        ops243.set_pitch_trigger_callback(_ops_pitch_trigger)

    # Tracks which mode's calibration is currently loaded into the pipeline.
    # Both calib_manual / calibrate also overwrite CALIBRATION_FILE for the mode
    # they just solved, so the freshest one is always active immediately.
    active_mode = {"mode": "hitting"}

    def _save_to_active(mode: str, path: str) -> None:
        """Copy the just-written per-mode calibration over CALIBRATION_FILE
        when we're already in that mode (or pre-existing default)."""
        import os
        if not os.path.exists(path):
            return
        shutil.copyfile(path, config.CALIBRATION_FILE)
        active_mode["mode"] = mode

    def calibrate_home(mode: str = "hitting") -> None:
        if collector.collecting:
            return
        log.info("Starting home-plate calibration … (mode=%s)", mode)
        collector.start_collecting()
        server.broadcast({
            "type": "calibration", "state": "collecting",
            "progress": 0, "total": collector.frames, "mode": mode,
        })
        threading.Thread(target=_finish_calibration, args=(mode,), daemon=True).start()

    def _finish_calibration(mode: str) -> None:
        deadline = time.monotonic() + 30.0
        last_broadcast = 0
        while not collector.done:
            time.sleep(0.15)
            now = time.monotonic()
            if now > deadline:
                collector.stop_collecting()
                server.broadcast({
                    "type": "calibration", "state": "error", "mode": mode,
                    "message": f"Only {collector.count}/{collector.frames} samples in 30 s — "
                               "make sure the plate is fully visible in both cameras.",
                })
                return
            if now - last_broadcast >= 0.25 and collector.count > 0:
                server.broadcast({
                    "type": "calibration", "state": "collecting",
                    "progress": collector.count, "total": collector.frames, "mode": mode,
                })
                last_broadcast = now

        collector.stop_collecting()
        mode_path = config.calibration_path_for(mode)
        focal_mm = config.LENS_FOCAL_MM_HITTING if mode == 'hitting' else config.LENS_FOCAL_MM
        result = collector.solve(mode_path, focal_mm=focal_mm)
        if result is None:
            server.broadcast({"type": "calibration", "state": "error", "mode": mode,
                              "message": "Calibration solve failed — see NUC console log."})
            return
        _save_to_active(mode, mode_path)
        pipeline.reload_calibration()
        log.info("Calibration complete (mode=%s): baseline=%.1fmm rms=%.1fmm reproj=%.2fpx",
                 mode, result["baselineMm"], result["rmsMm"], result["reprojPx"])
        server.broadcast({"type": "calibration", "state": "done", "mode": mode, **result})

    def calibrate_manual(corners0, corners1, height_mm, dist_mm, mode="hitting",
                         radar_behind_mm: float = 0.0, radar_height_mm: float = 0.0) -> None:
        log.info("Manual calibration requested (mode=%s, cam0=%d pts, cam1=%d pts)",
                 mode, len(corners0), len(corners1))
        def _run() -> None:
            import json, math as _m, os
            try:
                server.broadcast({"type": "calibration", "state": "collecting",
                                  "progress": 0, "total": 1, "mode": mode})
                mode_path = config.calibration_path_for(mode)
                focal_mm = config.LENS_FOCAL_MM_HITTING if mode == 'hitting' else config.LENS_FOCAL_MM
                result = solve_from_manual_corners(
                    corners0, corners1,
                    (config.WIDTH, config.HEIGHT),
                    mode_path,
                    height_mm=height_mm,
                    dist_mm=dist_mm,
                    focal_mm=focal_mm,
                )
                if result is None:
                    log.warning("Manual calibration solve returned None (PnP failed)")
                    server.broadcast({"type": "calibration", "state": "error", "mode": mode,
                                      "message": "Calibration solve failed — "
                                                 "check corner order: FL FR MR BP ML."})
                    return
                _save_to_active(mode, mode_path)
                pipeline.reload_calibration()
                log.info("Manual calibration done (mode=%s): baseline=%.1fmm rms=%.1fmm reproj=%.2fpx",
                         mode, result["baselineMm"], result["rmsMm"], result["reprojPx"])
                server.broadcast({"type": "calibration", "state": "done", "mode": mode, **result})

                # Update radar bore geometry if the user provided a position.
                if radar_behind_mm > 0 or radar_height_mm > 0:
                    behind_m = radar_behind_mm / 1000.0
                    height_m = radar_height_mm / 1000.0
                    pos = (0.0, height_m, -behind_m)
                    # Fixed aim point: pitcher's rubber at ground level.
                    aim = config.OPS243_AIM_POINT_M
                    bx = aim[0] - pos[0]
                    by = aim[1] - pos[1]
                    bz = aim[2] - pos[2]
                    bn = _m.sqrt(bx**2 + by**2 + bz**2)
                    bore = (bx/bn, by/bn, bz/bn) if bn > 1e-6 else (0.0, 0.0, 1.0)
                    config.OPS243_POSITION_M = pos
                    config.OPS243_BORE_UNIT  = bore
                    if ops243 is not None:
                        ops243.set_bore_unit(bore)
                    settings_path = os.path.join(os.path.dirname(__file__), "radar_settings.json")
                    try:
                        with open(settings_path, "w") as f:
                            json.dump({"position_m": list(pos)}, f)
                        log.info("Radar position saved: behind=%.0fmm height=%.0fmm  bore=(%.3f,%.3f,%.3f)",
                                 radar_behind_mm, radar_height_mm, *bore)
                    except Exception as exc:
                        log.warning("Could not save radar_settings.json: %s", exc)

            except Exception as exc:
                log.exception("Manual calibration thread crashed: %s", exc)
                server.broadcast({"type": "calibration", "state": "error", "mode": mode,
                                  "message": f"Internal error: {exc}"})
        threading.Thread(target=_run, daemon=True).start()

    def set_sub_session(sub_type) -> None:
        """Track the hitting sub-session type (tee / front_toss / live_bp / None)."""
        active_sub["type"] = sub_type
        log.info("Sub-session type → %s", sub_type)

    def set_session_mode(mode: str) -> None:
        """Swap which per-mode calibration the pipeline uses."""
        import os
        mode_path = config.calibration_path_for(mode)
        if not os.path.exists(mode_path):
            log.warning("set_session_mode(%s): %s not found — run calibration first",
                        mode, mode_path)
            server.broadcast({"type": "session_mode", "mode": mode, "calibrated": False})
            return
        shutil.copyfile(mode_path, config.CALIBRATION_FILE)
        active_mode["mode"] = mode
        pipeline.reload_calibration()
        log.info("Active session mode → %s (calibration reloaded)", mode)
        server.broadcast({"type": "session_mode", "mode": mode, "calibrated": True})

    server.set_callbacks(arm=arm, disarm=disarm, reset=reset,
                         trigger=manual_trigger,
                         calibrate=calibrate_home,
                         calib_manual=calibrate_manual,
                         set_session_mode=set_session_mode,
                         set_sub_session=set_sub_session,
                         get_status=lambda: {"type": "status", "state": "armed" if armed else "idle"})

    if args.no_cameras:
        log.warning("--no-cameras: running without stereo capture (UI / WebSocket only)")
    else:
        # On macOS the picker probes each camera index and keeps only the two
        # that can sustain ≥100 fps via MJPG @ 640×480 — i.e. the QILOVE
        # global-shutter pair. Log both the index, name, and the measured fps
        # so it's obvious if the wrong device got grabbed.
        cam_names = getattr(config, "_MACOS_CAM_NAMES", ["", ""])
        cam_fps   = getattr(config, "_MACOS_CAM_FPS",   [0.0, 0.0])
        if cam_names[0] or cam_names[1]:
            log.info("Stereo cameras selected (HW probe — ≥%.0f fps required):",
                     getattr(config, "_PROBE_MIN_FPS", 100))
            log.info("  cam0 (idx %d, %.0f fps): %s",
                     config.CAM0_IDX, cam_fps[0], cam_names[0] or "?")
            log.info("  cam1 (idx %d, %.0f fps): %s",
                     config.CAM1_IDX, cam_fps[1], cam_names[1] or "?")
        else:
            log.info("Stereo camera indices: cam0=%d  cam1=%d",
                     config.CAM0_IDX, config.CAM1_IDX)
        log.info("Starting stereo capture …")
        try:
            capturer.start()
        except RuntimeError as exc:
            log.error("Camera init failed: %s", exc)
            log.error("Run with --no-cameras to start without hardware.")
            raise

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

    _get_cam_fps = (lambda: capturer.measured_fps) if not args.no_cameras else None

    async def _run() -> None:
        await asyncio.gather(
            server.serve(),
            server.stream_health(get_cam_fps=_get_cam_fps),
            server.stream_calib_frames(lambda: collector),
            server.stream_radar(lambda: ops243),
        )

    try:
        loop.run_until_complete(_run())
    finally:
        if not args.no_cameras:
            capturer.stop()
        if spin_cap:
            spin_cap.stop()
        if ops243:
            ops243.stop()
        loop.close()
        log.info("Stopped.")


if __name__ == "__main__":
    main()
