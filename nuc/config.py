"""
Central configuration for the OVLM NUC pipeline.
Edit these values to match your hardware setup.
"""

import cv2

# ── Stereo cameras ────────────────────────────────────────────────────────────
# Hardware: QILOVE 800P monochrome global-shutter USB camera (OV9281-class),
# 5–50 mm CS varifocal lens. Frame rate is locked to resolution; the documented
# UVC modes are:  1280×800@120 / 640×480@210 / 320×240@420 / 160×120@640.
# The stereo pair runs 640×480@210 — triangulation accuracy is set by pixel
# resolution, and 210 fps already gives ~40+ points per flight window, so finer
# pixels beat more frames here. (For maximum accuracy you can instead use the
# full 1280×800@120 mode; for maximum temporal density drop to 320×240@420.)
CAM0_IDX   = 0          # OpenCV camera index for left stereo camera
CAM1_IDX   = 1          # OpenCV camera index for right stereo camera
WIDTH      = 640
HEIGHT     = 480
FRAMERATE  = 210         # fps, stereo pair — must match a mode the sensor supports

# OpenCV capture backend — CAP_MSMF is the Windows default (Media Foundation).
# Switch to cv2.CAP_DSHOW if MSMF can't reach the target framerate.
CAMERA_BACKEND = cv2.CAP_MSMF

# These cameras only deliver their high frame rates over MJPEG (the default
# YUY2/uncompressed path caps at ~30 fps). The FOURCC must be set BEFORE the
# resolution/fps or the camera stays in the slow uncompressed mode.
CAMERA_FOURCC = "MJPG"

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

# ── Spin camera (optional third camera) ───────────────────────────────────────
# Dedicated high-speed camera for spin rate / spin axis via seam tracking.
# Seam tracking is Nyquist-limited to half a rotation per frame, so the
# measurable ceiling scales with fps: ~9 400 RPM at 420 fps covers any batted
# ball or pitch. Runs the camera's 320×240@420 mode — zoom the 5–50 mm lens
# toward the long end and frame the contact zone tight so the ball is ≥20 px
# across, or the seams won't resolve at this resolution. (The 160×120@640 mode
# is usually too small for seams; try it only with the ball near frame-filling.)
# When disabled (or the camera fails to open), spin estimation falls back to
# stereo camera 0. Enable here or with: python main.py --spin-cam
SPIN_CAM_ENABLED        = False
SPIN_CAM_IDX            = 2
SPIN_CAM_WIDTH          = 320
SPIN_CAM_HEIGHT         = 240
SPIN_CAM_FPS            = 420
SPIN_CAM_EXPOSURE_VALUE = -12   # ≈0.25 ms — frame interval at 420 fps is 2.4 ms
SPIN_CAM_GAIN_VALUE     = 8     # shorter exposure needs more gain; -1 to skip

# Ball size bounds for the zoomed spin camera (px). Much larger than the
# stereo bounds — the lens is framed so the ball dominates the 320×240 frame.
SPIN_BALL_MIN_RADIUS_PX = 10
SPIN_BALL_MAX_RADIUS_PX = 90

# Loaded from camera_settings.json if it exists (written by camera_check.py)
import json as _json, os as _os
_settings_file = _os.path.join(_os.path.dirname(__file__), "camera_settings.json")
if _os.path.exists(_settings_file):
    try:
        _s = _json.load(open(_settings_file))
        EXPOSURE_VALUE          = _s.get("exposure_value",      EXPOSURE_VALUE)
        GAIN_VALUE              = _s.get("gain_value",          GAIN_VALUE)
        SPIN_CAM_EXPOSURE_VALUE = _s.get("spin_exposure_value", SPIN_CAM_EXPOSURE_VALUE)
        SPIN_CAM_GAIN_VALUE     = _s.get("spin_gain_value",     SPIN_CAM_GAIN_VALUE)
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

# ── Radar (OmniPreSense OPS243-C-FC-RP) ──────────────────────────────────────
# Single USB-serial port — plug the USB cable into any NUC USB-A port.
# Linux: usually /dev/ttyACM0 (check: ls /dev/ttyACM*)
# Windows: check Device Manager → Ports (COM & LPT)
OPS243_ENABLED       = True
OPS243_PORT          = '/dev/ttyACM0'
OPS243_BAUD          = 9600
OPS243_MIN_PITCH_MPS = 13.4   # ~30 mph inbound — slower = ignore (noise / wind)
OPS243_MIN_EV_MPS    = 17.9   # ~40 mph outbound — slower = ignore (bunts / foul tips)
OPS243_AGREE_FRACTION = 0.15  # EV agreement threshold vs. camera (15%)

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

# ── Home-plate AI calibration ─────────────────────────────────────────────────
# Calibrate the stereo rig from a regulation home plate in view — no ChArUco
# board. A keypoint model (plate_detector.py) finds the plate's 5 corners in
# both cameras; plate_calib.py runs PnP against the plate's known geometry to
# recover each camera's pose, hence the stereo extrinsics in metric scale.
#
# Regulation plate: 17" front edge, two 8.5" parallel sides, two 12" sides
# converging to the back point (back-depth = √(12²−8.5²) ≈ 8.47").
PLATE_FRONT_IN      = 17.0
PLATE_SIDE_IN       = 8.5
PLATE_BACK_IN       = 8.47          # √(12²−8.5²); front-edge → mid → point depth
PLATE_CALIB_FRAMES  = 30            # frames averaged for a stable corner solve
PLATE_MODEL_FILE    = "plate_keypoints.pt"   # trained weights (optional)

# Intrinsics are derived from the lens + sensor because a single planar view
# can't recover them reliably. Set these to match your camera/lens; the focal
# length can optionally be refined from the plate homography (--refine-focal).
SENSOR_PIXEL_PITCH_UM = 3.0         # OV9281 native pixel size
SENSOR_NATIVE_WIDTH   = 1280        # native sensor width (modes bin down from this)
LENS_FOCAL_MM         = 8.0         # set to your 5–50 mm lens's actual focal length

def focal_px(width: int = None) -> float:
    """Approx focal length in pixels for the current capture width, assuming the
    sub-1280 modes are 2×2-binned (so effective pixel pitch scales with width)."""
    w = width if width is not None else WIDTH
    native_fx = LENS_FOCAL_MM * 1000.0 / SENSOR_PIXEL_PITCH_UM
    return native_fx * (w / SENSOR_NATIVE_WIDTH)

# ── Paths ─────────────────────────────────────────────────────────────────────
CALIBRATION_FILE = "calibration.npz"
