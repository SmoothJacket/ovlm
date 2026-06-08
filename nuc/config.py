"""
Central configuration for the OVLM NUC pipeline.
Edit these values to match your hardware setup.
"""

import cv2

# ── Camera ────────────────────────────────────────────────────────────────────
CAM0_IDX   = 0          # OpenCV camera index for left camera
CAM1_IDX   = 1          # OpenCV camera index for right camera
WIDTH      = 640
HEIGHT     = 480
FRAMERATE  = 120         # fps — reduce to 60 if cameras can't reach 120

# OpenCV capture backend — CAP_MSMF is the Windows default (Media Foundation).
# Switch to cv2.CAP_DSHOW if MSMF can't reach the target framerate.
CAMERA_BACKEND = cv2.CAP_MSMF

# ── Exposure (CRITICAL for ball tracking) ─────────────────────────────────────
# On Windows, OpenCV sets exposure in log₂ seconds (DirectShow / MSMF convention):
#   -6 ≈ 15 ms,  -7 ≈ 7.8 ms,  -8 ≈ 3.9 ms,
#   -9 ≈ 2 ms,  -10 ≈ 1 ms,   -11 ≈ 0.5 ms,  -12 ≈ 0.25 ms
#
# Physics: a 90 mph ball moves ~40 m/s. At -11 (≈0.5 ms) it smears ~20 mm —
# acceptable. At auto-exposure (often -6 to -8) it smears 160+ mm: undetectable.
# Tune interactively with: python camera_check.py --preview
#
# Note: exact range and step size are camera/driver-dependent.
EXPOSURE_VALUE  = -11    # overridden by camera_settings.json if present
GAIN_VALUE      = 4      # 0–255 for most DirectShow/MSMF cameras; -1 to skip

# Loaded from camera_settings.json if it exists (written by camera_check.py)
import json as _json, os as _os
_settings_file = _os.path.join(_os.path.dirname(__file__), "camera_settings.json")
if _os.path.exists(_settings_file):
    try:
        _s = _json.load(open(_settings_file))
        EXPOSURE_VALUE = _s.get("exposure_value", EXPOSURE_VALUE)
        GAIN_VALUE     = _s.get("gain_value",     GAIN_VALUE)
    except Exception:
        pass

# ── Stereo geometry (overridden by calibration file if present) ───────────────
BASELINE_M      = 0.12   # meters between lens centers — measure your rig
FOCAL_LENGTH_PX = 460.0  # approximate; stereo calibration overwrites this

# ── Ball detection ────────────────────────────────────────────────────────────
BALL_MIN_RADIUS_PX = 4
BALL_MAX_RADIUS_PX = 30
MOG2_HISTORY       = 200
MOG2_THRESHOLD     = 16

# ── Audio trigger ─────────────────────────────────────────────────────────────
AUDIO_DEVICE_INDEX  = None   # None = system default mic
AUDIO_SAMPLE_RATE   = 44100
AUDIO_CHUNK         = 512
AUDIO_RMS_THRESHOLD = 0.40   # 0-1 normalised RMS
AUDIO_DEBOUNCE_S    = 0.6

# ── Frame buffer ──────────────────────────────────────────────────────────────
BUFFER_DURATION_S = 2.0   # total rolling window kept in RAM
HALF_WINDOW_S     = 0.5   # ±window around trigger that gets processed

# ── Physics ───────────────────────────────────────────────────────────────────
GRAVITY_M_S2       = 9.81
AIR_DENSITY        = 1.225
BALL_MASS_KG       = 0.1417
BALL_DIAMETER_M    = 0.0737
DRAG_COEFF         = 0.35

# ── Radar (TI IWR6843ISK) ─────────────────────────────────────────────────────
# On Windows the board registers as two COM ports after the USB driver installs.
# Check Device Manager → Ports (COM & LPT) — typically two consecutive ports.
RADAR_ENABLED               = False
RADAR_CONFIG_PORT           = 'COM3'
RADAR_DATA_PORT             = 'COM4'
RADAR_CONFIG_BAUD           = 115200
RADAR_DATA_BAUD             = 921600
RADAR_CONFIG_FILE           = 'radar_config.cfg'
RADAR_TRIGGER_VELOCITY_MPS  = 13.4   # ~30 mph — any faster object fires the trigger
RADAR_MIN_SNR_DB            = 10.0
RADAR_AGREE_FRACTION        = 0.15

# ── WebSocket server ──────────────────────────────────────────────────────────
WS_HOST = "0.0.0.0"
WS_PORT = 8765

# ── Paths ─────────────────────────────────────────────────────────────────────
CALIBRATION_FILE = "calibration.npz"
