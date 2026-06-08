"""
Central configuration for the OVLM Pi pipeline.
Edit these values to match your hardware setup.
"""

# ── Camera ────────────────────────────────────────────────────────────────────
CAM0_IDX   = 0          # picamera2 camera index for left lens
CAM1_IDX   = 1          # picamera2 camera index for right lens
WIDTH      = 640
HEIGHT     = 480
FRAMERATE  = 120         # fps — reduce to 60 if CPU can't keep up

# ── Exposure (CRITICAL for ball tracking) ─────────────────────────────────────
# Physics: a 90mph ball moves ~40 m/s. At 500µs exposure it smears ~20mm —
# acceptable. At auto-exposure (often 4–8ms) it smears 160–320mm: undetectable.
# Tune these interactively with: python camera_check.py --preview
#
# Typical starting points:
#   Indoors / dim:  EXPOSURE_TIME_US=800,  ANALOGUE_GAIN=12.0
#   Indoors / bright: EXPOSURE_TIME_US=400, ANALOGUE_GAIN=8.0
#   Outdoors:       EXPOSURE_TIME_US=250,  ANALOGUE_GAIN=4.0
EXPOSURE_TIME_US = 500    # µs — overridden by camera_settings.json if present
ANALOGUE_GAIN    = 8.0    # 1.0–16.0 — sensor-dependent maximum
AE_ENABLE        = False  # MUST be False; auto-exposure makes ball a blur
AWB_ENABLE       = False  # fixed white balance avoids per-frame colour shifts
COLOUR_GAINS     = (1.5, 1.2)  # (red, blue) — tune with camera_check.py

# Loaded from camera_settings.json if it exists (written by camera_check.py)
import json as _json, os as _os
_settings_file = _os.path.join(_os.path.dirname(__file__), "camera_settings.json")
if _os.path.exists(_settings_file):
    try:
        _s = _json.load(open(_settings_file))
        EXPOSURE_TIME_US = _s.get("exposure_us", EXPOSURE_TIME_US)
        ANALOGUE_GAIN    = _s.get("gain",        ANALOGUE_GAIN)
        COLOUR_GAINS     = tuple(_s.get("colour_gains", list(COLOUR_GAINS)))
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
# Connect the board via USB; it registers as two serial ports.
# On Raspberry Pi OS: /dev/ttyUSB0 (config) and /dev/ttyUSB1 (data).
# Add yourself to the dialout group once: sudo usermod -aG dialout $USER
RADAR_ENABLED               = False          # set True or pass --radar to main.py
RADAR_CONFIG_PORT           = '/dev/ttyUSB0'
RADAR_DATA_PORT             = '/dev/ttyUSB1'
RADAR_CONFIG_BAUD           = 115200
RADAR_DATA_BAUD             = 921600
RADAR_CONFIG_FILE           = 'radar_config.cfg'
RADAR_TRIGGER_VELOCITY_MPS  = 13.4   # ~30 mph — any faster object fires the trigger
RADAR_MIN_SNR_DB            = 10.0   # minimum SNR to accept a detection as real
# Velocity correction: if camera and radar both measured EV, accept radar when
# they agree within this fraction.  Otherwise keep camera value.
RADAR_AGREE_FRACTION        = 0.15   # 15% tolerance

# ── WebSocket server ──────────────────────────────────────────────────────────
WS_HOST = "0.0.0.0"
WS_PORT = 8765

# ── Paths ─────────────────────────────────────────────────────────────────────
CALIBRATION_FILE = "calibration.npz"
