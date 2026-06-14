# OVLM stereo calibration

Two ways to calibrate the stereo rig. Both write `calibration.npz`, which
`triangulate.py` loads automatically (`P0`/`P1` projection matrices).

## Option A — Home plate, no board (AI keypoint model)

A regulation home plate is a pentagon with exactly known dimensions, so it *is*
a metric calibration target. A keypoint model finds its five corners in both
cameras and PnP recovers the stereo geometry in true scale from a **single**
shared view of the plate.

```bash
python plate_calib.py --live                 # capture from both cameras
python plate_calib.py --live --refine-focal  # also estimate focal length
python plate_calib.py --pair left.png right.png   # solve from a saved pair
python plate_calib.py --verify               # rectified epipolar preview
```

Set your lens in `config.py` first — `LENS_FOCAL_MM` (your 5–50 mm lens's actual
setting) and `SENSOR_PIXEL_PITCH_UM` — because a single planar view can't recover
the focal length on its own. `--refine-focal` estimates it from the plate
homography if you'd rather not measure the lens.

Tips: get the plate as **large** in frame as you can, lit evenly, fully visible
in both cameras. The tool averages 30 frames and prints a self-check
(`triangulation RMS` in mm) — under ~5 mm is excellent.

### The AI model

`plate_detector.py` uses a learned corner detector when `plate_keypoints.pt` and
`torch` are present, and a classical white-pentagon detector otherwise (so
calibration works out of the box). Train the model on synthetic plates — no
labelling required:

```bash
pip install torch
python train_plate_model.py                  # → plate_keypoints.pt
python train_plate_model.py --preview 12     # sanity-check the synthetic data
```

The learned model is far more robust to dirt, glare, worn paint and partial
occlusion than the classical detector; the classical path is the zero-setup
fallback.

## Option B — ChArUco board

The original method, best absolute accuracy because it also solves full
intrinsics and lens distortion from many views.

```bash
python calibrate.py --print-board            # print this, mount it flat
python calibrate.py --live                   # capture ~25 board poses
python calibrate.py --verify
```

## Which to use

- **Plate** — fastest, nothing to print, recalibrate anytime the cameras move.
  Accuracy is limited by how large the plate sits in frame and by the lens-spec
  intrinsics.
- **Board** — most accurate, recovers intrinsics + distortion; worth doing once
  to pin down the lens, then use the plate for quick re-checks.
