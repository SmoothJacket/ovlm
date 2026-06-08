"""
Camera health check and exposure tuner.

Modes
-----
  python camera_check.py            — list detected cameras and their capabilities
  python camera_check.py --preview  — live side-by-side preview with exposure controls

Preview controls
----------------
  E / W   — exposure ×2 / ÷2
  G / F   — analogue gain +1 / -1
  R / T   — red colour gain +0.1 / -0.1
  B / N   — blue colour gain +0.1 / -0.1
  S       — save current settings to camera_settings.json (picked up by main.py)
  Q / ESC — quit

The blur ruler at the bottom shows how far a 90 mph ball travels during
the current exposure. Keep it under one ball-width (~10 px at typical range).
"""

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

BALL_SPEED_M_S    = 40.2    # 90 mph in m/s
BALL_DIAMETER_PX  = 12      # approximate at ~3 m range, 640 px wide
SETTINGS_FILE     = Path(__file__).parent / "camera_settings.json"

try:
    from picamera2 import Picamera2
    from picamera2.controls import Controls
    PICAMERA2_AVAILABLE = True
except ImportError:
    PICAMERA2_AVAILABLE = False


# ── Camera listing ────────────────────────────────────────────────────────────

def list_cameras() -> None:
    if not PICAMERA2_AVAILABLE:
        print("picamera2 is not installed.")
        sys.exit(1)

    cameras = Picamera2.global_camera_info()
    if not cameras:
        print("No cameras detected.")
        print("  Check: ls /dev/video*")
        print("  Check: vcgencmd get_camera")
        sys.exit(1)

    print(f"Found {len(cameras)} camera(s):\n")
    for i, info in enumerate(cameras):
        print(f"  [{i}] {info.get('Model', 'unknown')}  id={info.get('Id', '?')}")
        cam = Picamera2(i)
        sensor = cam.sensor_modes
        print(f"       Sensor modes:")
        for m in sensor[:4]:   # show first 4 modes
            size = m.get("size", "?")
            fps  = m.get("fps", "?")
            fmt  = m.get("format", "?")
            gs   = "GLOBAL SHUTTER" if m.get("bit_depth", 0) == 10 else ""
            print(f"         {size}  @{fps}fps  {fmt}  {gs}")
        cam.close()
        print()

    print("Tip: a global-shutter sensor (OV9281) gives the cleanest ball images.")
    print("     A rolling-shutter sensor (IMX708) is fine but avoid large tilt angles.")


# ── Exposure preview ──────────────────────────────────────────────────────────

def _blur_px(exposure_us: float) -> float:
    """Expected ball trail length in pixels at 90 mph at this exposure."""
    # Assumes ~3.9 m horizontal FOV at 3 m, 640 px wide → 6.1 mm/px
    mm_per_px = 6.1
    trail_mm  = BALL_SPEED_M_S * (exposure_us * 1e-6) * 1000.0
    return trail_mm / mm_per_px


def _draw_hud(
    canvas: np.ndarray,
    exposure_us: float,
    gain: float,
    colour_gains: tuple,
    fps_actual: float,
) -> None:
    h, w = canvas.shape[:2]
    bar_h = 120

    # Dark HUD background
    cv2.rectangle(canvas, (0, h - bar_h), (w, h), (15, 15, 20), -1)

    def text(s, x, y, color=(180, 180, 190), scale=0.5, thick=1):
        cv2.putText(canvas, s, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, color, thick, cv2.LINE_AA)

    # Exposure
    equiv = int(round(1_000_000 / exposure_us)) if exposure_us > 0 else 0
    text(f"EXPOSURE  {int(exposure_us)} us  (1/{equiv}s)", 10, h - bar_h + 20, (100, 220, 255), 0.55)
    text("E=x2  W=÷2", 10, h - bar_h + 38, scale=0.42)

    # Gain
    text(f"GAIN      {gain:.1f}x", 10, h - bar_h + 58, (100, 255, 160), 0.55)
    text("G=+1  F=-1", 10, h - bar_h + 74, scale=0.42)

    # Colour gains
    rg, bg = colour_gains
    text(f"WHITE BAL  R={rg:.2f}  B={bg:.2f}", 10, h - bar_h + 94, (220, 180, 100), 0.55)
    text("R/T=red  B/N=blue", 10, h - bar_h + 110, scale=0.42)

    # FPS
    text(f"{fps_actual:.0f} fps", w - 80, h - bar_h + 20, (160, 160, 160), 0.55)

    # ── Blur ruler ────────────────────────────────────────────────────────────
    ruler_x = w // 2 - 100
    ruler_y = h - bar_h + 20
    ruler_w = 200

    blur = _blur_px(exposure_us)
    clamped = min(blur, ruler_w)
    ok = blur <= BALL_DIAMETER_PX

    cv2.rectangle(canvas, (ruler_x, ruler_y - 12), (ruler_x + ruler_w, ruler_y), (30, 30, 30), -1)
    bar_color = (0, 220, 0) if ok else (0, 80, 220)
    cv2.rectangle(canvas, (ruler_x, ruler_y - 12), (ruler_x + int(clamped), ruler_y), bar_color, -1)

    # Ball-width marker
    ball_line_x = ruler_x + BALL_DIAMETER_PX
    cv2.line(canvas, (ball_line_x, ruler_y - 14), (ball_line_x, ruler_y + 2), (255, 255, 0), 1)

    label = f"BLUR {blur:.0f}px {'OK' if ok else 'TOO MUCH'}"
    text(label, ruler_x, ruler_y + 14, bar_color, 0.45)
    text(f"(ball ≈{BALL_DIAMETER_PX}px, yellow line)", ruler_x, ruler_y + 26, (100, 100, 100), 0.38)

    # Save hint
    text("S=save settings   Q=quit", w // 2 - 80, h - bar_h + 90, (120, 120, 120), 0.42)


def _save_settings(exposure_us: float, gain: float, colour_gains: tuple) -> None:
    data = {
        "exposure_us":   int(exposure_us),
        "gain":          round(gain, 2),
        "colour_gains":  [round(colour_gains[0], 3), round(colour_gains[1], 3)],
    }
    SETTINGS_FILE.write_text(json.dumps(data, indent=2))
    print(f"Saved → {SETTINGS_FILE}")
    print(f"  exposure_us={data['exposure_us']}  gain={data['gain']}  colour_gains={data['colour_gains']}")


def preview() -> None:
    if not PICAMERA2_AVAILABLE:
        print("picamera2 is not installed.")
        sys.exit(1)

    import config  # local import so config loads current camera_settings.json

    exposure_us   = float(config.EXPOSURE_TIME_US)
    gain          = float(config.ANALOGUE_GAIN)
    colour_gains  = list(config.COLOUR_GAINS)
    fps_target    = config.FRAMERATE

    def make_cam(idx):
        cam = Picamera2(idx)
        cfg = cam.create_video_configuration(
            main={"format": "BGR888", "size": (config.WIDTH, config.HEIGHT)},
        )
        cam.configure(cfg)
        return cam

    cams = Picamera2.global_camera_info()
    if len(cams) < 2:
        print(f"Warning: only {len(cams)} camera(s) detected — showing what's available.")

    cam0 = make_cam(config.CAM0_IDX)
    cam1 = make_cam(config.CAM1_IDX) if len(cams) > 1 else None

    def apply_controls(c):
        c.set_controls({
            "AeEnable":     False,
            "AwbEnable":    False,
            "ExposureTime": int(exposure_us),
            "AnalogueGain": gain,
            "ColourGains":  (colour_gains[0], colour_gains[1]),
            "FrameRate":    float(fps_target),
        })

    cam0.start()
    if cam1:
        cam1.start()

    apply_controls(cam0)
    if cam1:
        apply_controls(cam1)

    print("Preview running. Controls: E/W=exposure  G/F=gain  R/T=red  B/N=blue  S=save  Q=quit")

    import time
    fps_actual = fps_target
    t_last = time.monotonic()
    frame_count = 0

    while True:
        f0 = cam0.capture_array("main")
        f1 = cam1.capture_array("main") if cam1 else f0.copy()

        frame_count += 1
        now = time.monotonic()
        if now - t_last >= 1.0:
            fps_actual = frame_count / (now - t_last)
            frame_count = 0
            t_last = now

        combined = np.hstack([f0, f1])
        _draw_hud(combined, exposure_us, gain, tuple(colour_gains), fps_actual)
        cv2.imshow("OVLM Camera Check", combined)

        key = cv2.waitKey(1) & 0xFF
        changed = False

        if key in (ord('q'), 27):
            break
        elif key == ord('e'):
            exposure_us = min(exposure_us * 2, 8000)
            changed = True
        elif key == ord('w'):
            exposure_us = max(exposure_us / 2, 50)
            changed = True
        elif key == ord('g'):
            gain = min(gain + 1.0, 16.0)
            changed = True
        elif key == ord('f'):
            gain = max(gain - 1.0, 1.0)
            changed = True
        elif key == ord('r'):
            colour_gains[0] = min(colour_gains[0] + 0.1, 4.0)
            changed = True
        elif key == ord('t'):
            colour_gains[0] = max(colour_gains[0] - 0.1, 0.5)
            changed = True
        elif key == ord('b'):
            colour_gains[1] = min(colour_gains[1] + 0.1, 4.0)
            changed = True
        elif key == ord('n'):
            colour_gains[1] = max(colour_gains[1] - 0.1, 0.5)
            changed = True
        elif key == ord('s'):
            _save_settings(exposure_us, gain, tuple(colour_gains))

        if changed:
            apply_controls(cam0)
            if cam1:
                apply_controls(cam1)

    cv2.destroyAllWindows()
    cam0.stop()
    if cam1:
        cam1.stop()


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="OVLM camera check")
    parser.add_argument("--preview", action="store_true",
                        help="Open live preview with interactive exposure controls")
    args = parser.parse_args()

    if args.preview:
        preview()
    else:
        list_cameras()
