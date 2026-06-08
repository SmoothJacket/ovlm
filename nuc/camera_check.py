"""
Camera health check and exposure tuner.

Modes
-----
  python camera_check.py            — list detected cameras
  python camera_check.py --preview  — live side-by-side preview with exposure controls

Preview controls
----------------
  E / W   — exposure +1 / -1 (log₂ steps; more negative = shorter)
  G / F   — gain +1 / -1
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

import config

BALL_SPEED_M_S   = 40.2    # 90 mph in m/s
BALL_DIAMETER_PX = 12      # approximate at ~3 m range, 640 px wide
SETTINGS_FILE    = Path(__file__).parent / "camera_settings.json"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _blur_px(exposure_value: int) -> float:
    """Expected ball trail length in pixels at 90 mph (log₂ exposure scale)."""
    exposure_s = 2.0 ** exposure_value
    mm_per_px  = 6.1   # ~3.9 m horizontal FOV at 3 m, 640 px wide
    trail_mm   = BALL_SPEED_M_S * exposure_s * 1000.0
    return trail_mm / mm_per_px


def _open_camera(idx: int, exposure_value: int, gain_value: int) -> cv2.VideoCapture:
    cap = cv2.VideoCapture(idx, config.CAMERA_BACKEND)
    if not cap.isOpened():
        return None
    cap.set(cv2.CAP_PROP_FRAME_WIDTH,  config.WIDTH)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, config.HEIGHT)
    cap.set(cv2.CAP_PROP_FPS,          float(config.FRAMERATE))
    cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25)   # 0.25 = manual
    cap.set(cv2.CAP_PROP_EXPOSURE, float(exposure_value))
    if gain_value >= 0:
        cap.set(cv2.CAP_PROP_GAIN, float(gain_value))
    return cap


def _apply_controls(cap: cv2.VideoCapture, exposure_value: int, gain_value: int) -> None:
    cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25)
    cap.set(cv2.CAP_PROP_EXPOSURE, float(exposure_value))
    if gain_value >= 0:
        cap.set(cv2.CAP_PROP_GAIN, float(gain_value))


# ── Camera listing ────────────────────────────────────────────────────────────

def list_cameras() -> None:
    print("Scanning camera indices 0–9 …\n")
    found = []
    for i in range(10):
        cap = cv2.VideoCapture(i, config.CAMERA_BACKEND)
        if cap.isOpened():
            w   = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            h   = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            fps = cap.get(cv2.CAP_PROP_FPS)
            print(f"  [{i}] {w}×{h} @ {fps:.0f} fps")
            found.append(i)
            cap.release()

    if not found:
        print("No cameras detected.")
        print("  Check Device Manager → Imaging Devices / Cameras")
        sys.exit(1)

    print(f"\nFound {len(found)} camera(s). Set CAM0_IDX and CAM1_IDX in config.py.")
    print("Tip: a global-shutter USB camera (e.g. OV9281 module) gives the cleanest ball images.")


# ── HUD drawing ───────────────────────────────────────────────────────────────

def _draw_hud(
    canvas: np.ndarray,
    exposure_value: int,
    gain_value: int,
    fps_actual: float,
) -> None:
    h, w = canvas.shape[:2]
    bar_h = 110

    cv2.rectangle(canvas, (0, h - bar_h), (w, h), (15, 15, 20), -1)

    def text(s, x, y, color=(180, 180, 190), scale=0.5, thick=1):
        cv2.putText(canvas, s, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, color, thick, cv2.LINE_AA)

    exposure_ms = (2.0 ** exposure_value) * 1000.0
    text(f"EXPOSURE  {exposure_value}  ({exposure_ms:.3f} ms)", 10, h - bar_h + 20, (100, 220, 255), 0.55)
    text("E=+1  W=-1", 10, h - bar_h + 38, scale=0.42)

    text(f"GAIN      {gain_value}", 10, h - bar_h + 58, (100, 255, 160), 0.55)
    text("G=+1  F=-1", 10, h - bar_h + 74, scale=0.42)

    text(f"{fps_actual:.0f} fps", w - 80, h - bar_h + 20, (160, 160, 160), 0.55)

    # ── Blur ruler ────────────────────────────────────────────────────────────
    ruler_x = w // 2 - 100
    ruler_y = h - bar_h + 22
    ruler_w = 200

    blur    = _blur_px(exposure_value)
    clamped = min(blur, ruler_w)
    ok      = blur <= BALL_DIAMETER_PX

    cv2.rectangle(canvas, (ruler_x, ruler_y - 12), (ruler_x + ruler_w, ruler_y), (30, 30, 30), -1)
    bar_color = (0, 220, 0) if ok else (0, 80, 220)
    cv2.rectangle(canvas, (ruler_x, ruler_y - 12), (ruler_x + int(clamped), ruler_y), bar_color, -1)

    ball_line_x = ruler_x + BALL_DIAMETER_PX
    cv2.line(canvas, (ball_line_x, ruler_y - 14), (ball_line_x, ruler_y + 2), (255, 255, 0), 1)

    label = f"BLUR {blur:.0f}px {'OK' if ok else 'TOO MUCH'}"
    text(label, ruler_x, ruler_y + 14, bar_color, 0.45)
    text(f"(ball ≈{BALL_DIAMETER_PX}px, yellow line)", ruler_x, ruler_y + 26, (100, 100, 100), 0.38)

    text("S=save settings   Q=quit", w // 2 - 80, h - bar_h + 100, (120, 120, 120), 0.42)


def _save_settings(exposure_value: int, gain_value: int) -> None:
    data = {"exposure_value": exposure_value, "gain_value": gain_value}
    SETTINGS_FILE.write_text(json.dumps(data, indent=2))
    print(f"Saved → {SETTINGS_FILE}")
    print(f"  exposure_value={exposure_value}  gain_value={gain_value}")


# ── Live preview ──────────────────────────────────────────────────────────────

def preview() -> None:
    exposure_value = config.EXPOSURE_VALUE
    gain_value     = config.GAIN_VALUE

    cap0 = _open_camera(config.CAM0_IDX, exposure_value, gain_value)
    if cap0 is None:
        print(f"Cannot open camera {config.CAM0_IDX}. Run without --preview to list cameras.")
        sys.exit(1)

    cap1 = _open_camera(config.CAM1_IDX, exposure_value, gain_value)
    if cap1 is None:
        print(f"Warning: cannot open camera {config.CAM1_IDX} — showing single camera.")

    print("Preview running. Controls: E/W=exposure  G/F=gain  S=save  Q=quit")

    import time
    fps_actual  = float(config.FRAMERATE)
    t_last      = time.monotonic()
    frame_count = 0

    while True:
        ok0, f0 = cap0.read()
        if not ok0:
            continue

        if cap1 is not None:
            ok1, f1 = cap1.read()
            f1 = f1 if ok1 else f0.copy()
        else:
            f1 = f0.copy()

        frame_count += 1
        now = time.monotonic()
        if now - t_last >= 1.0:
            fps_actual  = frame_count / (now - t_last)
            frame_count = 0
            t_last      = now

        combined = np.hstack([f0, f1])
        _draw_hud(combined, exposure_value, gain_value, fps_actual)
        cv2.imshow("OVLM Camera Check", combined)

        key     = cv2.waitKey(1) & 0xFF
        changed = False

        if key in (ord('q'), 27):
            break
        elif key == ord('e'):
            exposure_value = min(exposure_value + 1, 0)
            changed = True
        elif key == ord('w'):
            exposure_value = max(exposure_value - 1, -14)
            changed = True
        elif key == ord('g'):
            gain_value = min(gain_value + 1, 255)
            changed = True
        elif key == ord('f'):
            gain_value = max(gain_value - 1, 0)
            changed = True
        elif key == ord('s'):
            _save_settings(exposure_value, gain_value)

        if changed:
            _apply_controls(cap0, exposure_value, gain_value)
            if cap1 is not None:
                _apply_controls(cap1, exposure_value, gain_value)

    cv2.destroyAllWindows()
    cap0.release()
    if cap1 is not None:
        cap1.release()


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
