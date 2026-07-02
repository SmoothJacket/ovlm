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
WIDTH      = 640
HEIGHT     = 480
FRAMERATE  = 210         # fps, stereo pair — must match a mode the sensor supports

# Camera indices — set below in the platform-specific block (skips FaceTime /
# Continuity cameras on macOS). Override with camera_settings.json if needed.

# ── Platform-specific camera backend & exposure ───────────────────────────────
import sys as _sys


# Probe parameters for identifying the two global-shutter cameras on macOS by
# measured hardware capability. system_profiler / name matching is unreliable
# because OpenCV's AVFoundation enumeration order isn't guaranteed to match,
# and Continuity / Studio Display cameras can shuffle the list. We instead
# open each index and measure actual FPS — only the QILOVE-class global-
# shutter cameras can sustain >100 fps via MJPG at 640×480; FaceTime, iPhone
# Continuity, and Studio Display cameras top out around 30 fps.
_PROBE_MAX_INDEX  = 6
_PROBE_DURATION_S = 1.2
_PROBE_MIN_FPS    = 100.0

# Filled in below by _macos_stereo_indices(); read by main.py at startup so
# the names of the two chosen cameras can be logged for verification.
_MACOS_CAM_NAMES: list = ["", ""]
_MACOS_CAM_FPS:   list = [0.0, 0.0]


def _measure_fps_and_size(idx: int) -> tuple:
    """Open camera index `idx`, push it into MJPG@640×480@210fps mode, then
    measure actual fps over _PROBE_DURATION_S seconds. Returns
    (fps, width, height) — (0, 0, 0) if the camera doesn't open or doesn't
    deliver any frames in that window.

    AVFoundation's index order does NOT match `system_profiler`'s output, so
    we cannot rely on names — only on what the device actually delivers."""
    cap = cv2.VideoCapture(idx, cv2.CAP_AVFOUNDATION)
    if not cap.isOpened():
        return (0.0, 0, 0)
    try:
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        cap.set(cv2.CAP_PROP_FRAME_WIDTH,  640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        cap.set(cv2.CAP_PROP_FPS,          210.0)
        # Warm-up frame (first read sometimes blocks while the device negotiates)
        cap.read()
        import time as _t
        t0 = _t.monotonic()
        n, w, h = 0, 0, 0
        while _t.monotonic() - t0 < _PROBE_DURATION_S:
            ok, f = cap.read()
            if ok and f is not None:
                n += 1
                if w == 0:
                    h, w = f.shape[:2]
        elapsed = _t.monotonic() - t0
        return (n / elapsed if elapsed > 0 else 0.0, w, h)
    finally:
        cap.release()


def _macos_stereo_indices() -> tuple:
    """Probe each AVFoundation camera index to find the two highest-fps ones —
    those are the QILOVE global-shutter cameras. Any camera unable to sustain
    _PROBE_MIN_FPS (default 100 fps) is rejected, so the laptop's FaceTime
    camera, iPhone Continuity, Studio Display, and screen-capture devices
    are excluded by their HARDWARE LIMIT, not by name (system_profiler order
    is unreliable — it doesn't necessarily match AVFoundation index order).

    Override the probe by setting both OVLM_CAM0_IDX and OVLM_CAM1_IDX env
    vars (useful for tests on machines with no cameras, or for forcing a
    specific pair when the auto-pick gets it wrong).

    Raises RuntimeError if fewer than two high-fps cameras are found."""
    import os as _os
    env0, env1 = _os.environ.get("OVLM_CAM0_IDX"), _os.environ.get("OVLM_CAM1_IDX")
    if env0 is not None and env1 is not None:
        try:
            i0, i1 = int(env0), int(env1)
            _MACOS_CAM_NAMES[0] = f"env-forced idx {i0}"
            _MACOS_CAM_NAMES[1] = f"env-forced idx {i1}"
            return i0, i1
        except ValueError:
            pass   # fall through to probe if env vars are garbage

    print("[config] Probing cameras for stereo pair (this takes a few seconds)…",
          flush=True)
    candidates = []  # (idx, fps, w, h)
    for idx in range(_PROBE_MAX_INDEX):
        fps, w, h = _measure_fps_and_size(idx)
        if fps <= 0:
            continue
        passed = "✓" if fps >= _PROBE_MIN_FPS else "✗ (too slow — built-in / Continuity)"
        print(f"[config]   idx {idx}: {fps:6.1f} fps  {w}×{h}  {passed}",
              flush=True)
        candidates.append((idx, fps, w, h))

    fast = [c for c in candidates if c[1] >= _PROBE_MIN_FPS]
    if len(fast) >= 2:
        # Two fastest = the global-shutter pair. Stable index order so
        # cam0/cam1 mapping doesn't flip between runs.
        fast.sort(key=lambda c: -c[1])
        picks = sorted(fast[:2], key=lambda c: c[0])
        (i0, f0, w0, h0), (i1, f1, w1, h1) = picks[0], picks[1]
        _MACOS_CAM_NAMES[0] = f"Global Shutter @ {w0}×{h0}"
        _MACOS_CAM_NAMES[1] = f"Global Shutter @ {w1}×{h1}"
        _MACOS_CAM_FPS[0],   _MACOS_CAM_FPS[1]   = f0, f1
        return i0, i1

    raise RuntimeError(
        f"Need 2 global-shutter cameras delivering ≥{_PROBE_MIN_FPS:.0f} fps; "
        f"found {len(fast)}. Probed indices: "
        f"{[(i, round(f,1), w, h) for i, f, w, h in candidates]}. "
        f"Plug both QILOVE cameras into USB and try again."
    )


def _macos_default_ops243_port() -> str:
    """Auto-detect the OPS243 USB-serial port on macOS. Picks the lowest-
    numbered /dev/cu.usbmodem* device (the OPS243 enumerates as a CDC ACM
    device; if anything else is plugged into a USB port at the same time it
    will also show up here, so override via OVLM_OPS243_PORT env if needed)."""
    import glob as _glob, os as _os
    env = _os.environ.get("OVLM_OPS243_PORT")
    if env:
        return env
    matches = sorted(_glob.glob("/dev/cu.usbmodem*"))
    return matches[0] if matches else "/dev/cu.usbmodem14201"   # fallback


if _sys.platform == "darwin":
    CAMERA_BACKEND = cv2.CAP_AVFOUNDATION
    # macOS AVFoundation exposes CAP_PROP_EXPOSURE in absolute seconds, not the
    # log₂-seconds convention used by DirectShow/V4L2.  Setting -11 (intended as
    # ≈0.5 ms log₂) is interpreted as -11 s — invalid — producing black frames.
    # Disable manual exposure on macOS; let AVFoundation auto-expose instead.
    # For production QILOVE cameras on Mac, tune via camera_check.py once you
    # know the right absolute-seconds value for your lens + lighting.
    APPLY_EXPOSURE  = False
    _OPS243_PORT_DEFAULT = _macos_default_ops243_port()
    CAM0_IDX, CAM1_IDX = _macos_stereo_indices()
elif _sys.platform == "win32":
    CAMERA_BACKEND  = cv2.CAP_MSMF
    APPLY_EXPOSURE  = True
    _OPS243_PORT_DEFAULT = 'COM3'
    CAM0_IDX, CAM1_IDX = 0, 1
else:  # Linux / NUC
    CAMERA_BACKEND  = cv2.CAP_V4L2
    APPLY_EXPOSURE  = True
    _OPS243_PORT_DEFAULT = '/dev/ttyACM0'
    CAM0_IDX, CAM1_IDX = 0, 1

# These cameras only deliver their high frame rates over MJPEG (the default
# YUY2/uncompressed path caps at ~30 fps). The FOURCC must be set BEFORE the
# resolution/fps or the camera stays in the slow uncompressed mode.
# On macOS, AVFoundation accepts MJPG for UVC cameras (QILOVE included);
# built-in cameras silently ignore the FOURCC and use their native format.
CAMERA_FOURCC = "MJPG"

# ── Exposure (CRITICAL for ball tracking on Linux/Windows) ────────────────────
# On Linux/Windows, OpenCV sets exposure in log₂ seconds (V4L2 / DirectShow):
#   -6 ≈ 15 ms,  -7 ≈ 7.8 ms,  -8 ≈ 3.9 ms,
#   -9 ≈ 2 ms,  -10 ≈ 1 ms,   -11 ≈ 0.5 ms,  -12 ≈ 0.25 ms
#
# Physics: a 90 mph ball moves ~40 m/s. At -11 (≈0.5 ms) it smears ~20 mm —
# acceptable. At auto-exposure (often -6 to -8) it smears 160+ mm: undetectable.
# Tune interactively with: python camera_check.py --preview
#
# APPLY_EXPOSURE=False on macOS — see note above.
EXPOSURE_VALUE  = -11    # overridden by camera_settings.json if present
GAIN_VALUE      = 4      # 0–255 for most V4L2/DirectShow cameras; -1 to skip

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

# ── Lens focal length (varifocal 5–50 mm; set to match physical lens position) ─
# PITCHING (camera 10 ft behind plate = 70 ft from release):
#   Use 25–50 mm — NOT the wide end. A pitch breaks ≤18 in so the path is only
#   ~1 m wide; a 25 mm lens sees a 3.3 m window at 70 ft, covers every pitch.
#   At 25 mm the ball is 7 px radius at release (seam-trackable) → 50 px near
#   plate.  At 50 mm: 14 px at release, extremely clear seams the whole flight.
#   DO NOT use 5–8 mm: ball is 1–2 px at 70 ft and cannot be detected.
#
# HITTING (camera 10 ft behind plate, ball starts at plate and travels away):
#   Use 8–15 mm for a wide enough view to follow the batted ball.
LENS_FOCAL_MM         = 25.0   # minimum for full-flight pitching seam tracking
LENS_FOCAL_MM_HITTING = 5.0    # wider for batted ball departure tracking

# ── Ball detection ────────────────────────────────────────────────────────────
# Pitching mode: at 60 ft with a ~25–50 mm lens the ball is ≈2–4 px radius;
# setting min to 2 lets the trajectory fitter capture the full flight.
# Seam tracking needs radius ≥ BALL_MIN_RADIUS_SEAM_PX to resolve features —
# below that the frame still feeds the trajectory but skips the spin step.
BALL_MIN_RADIUS_PX      = 2   # trajectory detection — catch ball at 70 ft (pitching)
BALL_MAX_RADIUS_PX      = 80  # ball at ~10 ft from camera is 50–70 px at 25–35 mm lens
BALL_MIN_RADIUS_SEAM_PX = 6   # minimum radius for reliable seam phase-correlation
MOG2_HISTORY            = 200
MOG2_THRESHOLD          = 16

# ── Audio trigger ─────────────────────────────────────────────────────────────
AUDIO_DEVICE_INDEX  = None   # None = system default mic
AUDIO_SAMPLE_RATE   = 44100
AUDIO_CHUNK         = 512
AUDIO_RMS_THRESHOLD = 0.40   # 0-1 normalised RMS
AUDIO_DEBOUNCE_S    = 0.6

# ── Frame buffer ──────────────────────────────────────────────────────────────
BUFFER_DURATION_S = 2.0   # total rolling window kept in RAM
HALF_WINDOW_S     = 0.7   # ±window around trigger; 0.7 s covers a 70 mph pitch (≈0.58 s flight)

# ── Physics ───────────────────────────────────────────────────────────────────
GRAVITY_M_S2    = 9.81
AIR_DENSITY     = 1.225
BALL_MASS_KG    = 0.1417
BALL_DIAMETER_M = 0.0737
BALL_RADIUS_M   = BALL_DIAMETER_M / 2
DRAG_COEFF      = 0.35

# Magnus lift coefficient model: CL = MAGNUS_CL_CONST + MAGNUS_CL_SLOPE × S
# where S = r·ω/v (spin parameter). Fit to baseball wind-tunnel data (Nathan 2012).
# Used to invert Magnus acceleration magnitude → spin rate.
MAGNUS_CL_CONST = 0.09
MAGNUS_CL_SLOPE = 0.60

# ── Radar (OmniPreSense OPS243-C-FC-RP) ──────────────────────────────────────
# Single USB-serial port — plug the USB cable into any NUC USB-A port.
# Linux: usually /dev/ttyACM0 (check: ls /dev/ttyACM*)
# Windows: check Device Manager → Ports (COM & LPT)
OPS243_ENABLED       = True
OPS243_PORT          = _OPS243_PORT_DEFAULT
OPS243_BAUD          = 9600
OPS243_MIN_PITCH_MPS = 20.12  # ~45 mph inbound — filters body-movement false positives
OPS243_MIN_EV_MPS    = 17.88  # ~40 mph outbound — matches MEAS_MIN_EV_MPH pipeline floor
OPS243_AGREE_FRACTION = 0.15  # EV agreement threshold vs. camera (15%)
# EV speed-scale calibration: multiply cosine-corrected radar EV by this factor.
# Derived from a known reference hit: radar read 74.9 mph, actual EV = 79.3 mph
#   → scale = 79.3 / 74.9 = 1.059
OPS243_EV_SCALE = 1.059

# Minimum Doppler magnitude — rejects weak returns (RF noise, distant objects).
# A baseball at typical distances returns magnitude 50–200+; raise this if noise
# persists, lower it if real balls are being missed at long range.
OPS243_MIN_MAGNITUDE = 20  # baseballs at 1–5 m return 50–200+; raise further if noise persists

# Cosine correction for angled radar mounting (degrees, 0 = disabled).
# Pitch (inbound, ball approaching radar) and EV (outbound, ball leaving contact zone)
# travel different directions relative to the radar, so each gets its own angle.
# How to calibrate: angle = arccos(raw_reading / known_actual_speed)
# Calibrated from measured vs actual:
#   Pitch inbound:  raw=39.5 mph, actual=89 mph  → arccos(39.5/89)  = 63.7°
#   EV outbound:    raw≈78 mph,   actual≈86 mph  → best fit across 2 hits = 23.9°
#   (EV ball travels nearly straight away from radar; pitch crosses more obliquely)
# Radar geometry — exact per-shot cosine correction via the camera velocity vector.
# OPS243_POSITION_M: where the radar sits (metres from plate centre).
# OPS243_AIM_POINT_M: fixed aim point (pitcher's rubber, ground level) — not user-editable.
# Bore unit vector is computed automatically. Override position via the calibration
# screen (saved to radar_settings.json) or edit directly here.
OPS243_POSITION_M  = (0.0, 0.46, -0.30)   # default: centred, ~18 in high, 12 in behind plate
OPS243_AIM_POINT_M = (0.0, 0.0,  18.44)   # pitcher's rubber — fixed, not user-editable

# Load position override from radar_settings.json if saved by the calibration UI.
_radar_settings = _os.path.join(_os.path.dirname(__file__), "radar_settings.json")
if _os.path.exists(_radar_settings):
    try:
        _rp = _json.load(open(_radar_settings)).get("position_m")
        if _rp and len(_rp) == 3:
            OPS243_POSITION_M = (float(_rp[0]), float(_rp[1]), float(_rp[2]))
    except Exception:
        pass

import math as _math
_bx = OPS243_AIM_POINT_M[0] - OPS243_POSITION_M[0]
_by = OPS243_AIM_POINT_M[1] - OPS243_POSITION_M[1]
_bz = OPS243_AIM_POINT_M[2] - OPS243_POSITION_M[2]
_bn = _math.sqrt(_bx**2 + _by**2 + _bz**2)
OPS243_BORE_UNIT = (_bx/_bn, _by/_bn, _bz/_bn) if _bn > 1e-6 else (0.0, 0.0, 1.0)
del _bx, _by, _bz, _bn

# ── Measurement validity gates (post-fit) ─────────────────────────────────────
# A trigger fires the pipeline; the pipeline only BROADCASTS a measurement
# when the resulting fit looks physically like a real ball flight. Anything
# rejected here just bumps the system back to ARMED without a metric.
MEAS_MIN_EV_MPH         = 40.0   # below this is almost certainly tracking noise
MEAS_MAX_EV_MPH         = 130.0  # above this is unphysical (MLB record ≈ 122 mph)
MEAS_MAX_RESIDUAL_MM    = 50.0   # ballistic fit RMS — > 50 mm means it wasn't a coherent flight
MEAS_MIN_POINTS_USED    = 8      # fewer inlier points → fit is too uncertain
MEAS_MIN_DETECT_RATE    = 0.40   # ball lost too often → tracking blob, not ball

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
SENSOR_PIXEL_PITCH_UM = 3.0    # OV9281 native pixel size
SENSOR_NATIVE_WIDTH   = 1280   # native sensor width (modes bin down from this)

def focal_px(focal_mm: float = None, width: int = None) -> float:
    """Approx focal length in pixels for the given focal length and capture width.
    Sub-1280 modes are 2×2-binned so effective pixel pitch scales with width."""
    f = focal_mm if focal_mm is not None else LENS_FOCAL_MM
    w = width    if width    is not None else WIDTH
    native_fx = f * 1000.0 / SENSOR_PIXEL_PITCH_UM
    return native_fx * (w / SENSOR_NATIVE_WIDTH)

# ── Paths ─────────────────────────────────────────────────────────────────────
# CALIBRATION_FILE is the *active* calibration the tracking pipeline reads.
# Per-mode files preserve a Hitting and a Pitching calibration so the user can
# physically reposition the cameras between modes without losing the other one.
# Switching sessions in the UI copies the mode-specific file over CALIBRATION_FILE
# and triggers pipeline.reload_calibration().
CALIBRATION_FILE          = "calibration.npz"
CALIBRATION_FILE_HITTING  = "calibration_hitting.npz"
CALIBRATION_FILE_PITCHING = "calibration_pitching.npz"


def calibration_path_for(mode: str) -> str:
    """Return the per-mode calibration file path. Defaults to the hitting file."""
    if mode == "pitching":
        return CALIBRATION_FILE_PITCHING
    return CALIBRATION_FILE_HITTING
