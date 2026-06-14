"""
Home-plate corner detector — the "AI calibration model".

detect_plate_corners(bgr) returns a (5, 2) float32 array of the plate's corner
pixel coordinates, or None if no plate is found. Corner identity/order is NOT
assumed here — plate_calib.py resolves front/back and left/right geometrically.

Two backends, chosen automatically:
  1. Learned keypoint CNN (PlateKeypointNet) when torch is installed AND a
     weights file (config.PLATE_MODEL_FILE) is present. Trained by
     train_plate_model.py on synthetic plates. This is the robust path —
     it tolerates dirt, partial occlusion, odd lighting and worn paint.
  2. Classical white-pentagon detector otherwise, so calibration works out of
     the box with zero setup (just needs a reasonably clean, well-lit plate).

The CNN regresses 5 normalized corner coordinates directly (10 outputs) from a
fixed-size crop; cheap enough to run on a NUC CPU in a few ms.
"""

from __future__ import annotations

import os
from typing import Optional

import cv2
import numpy as np

import config

# ── Learned backend (lazy / optional) ─────────────────────────────────────────
_INPUT = 192            # model input resolution (square)
_model = None           # cached torch model
_torch = None           # cached torch module
_model_tried = False


def _try_load_model():
    """Load the keypoint CNN once. Returns (torch, model) or (None, None)."""
    global _model, _torch, _model_tried
    if _model_tried:
        return _torch, _model
    _model_tried = True
    weights = config.PLATE_MODEL_FILE
    if not os.path.exists(weights):
        return None, None
    try:
        import torch
        from plate_model import PlateKeypointNet
        net = PlateKeypointNet()
        state = torch.load(weights, map_location="cpu")
        net.load_state_dict(state)
        net.eval()
        _torch, _model = torch, net
        print(f"[plate_detector] Loaded keypoint model from {weights}")
    except Exception as e:  # torch missing or weights incompatible → classical
        print(f"[plate_detector] Keypoint model unavailable ({e}); using classical detector")
        _torch, _model = None, None
    return _torch, _model


def _detect_cnn(bgr: np.ndarray) -> Optional[np.ndarray]:
    torch, net = _try_load_model()
    if net is None:
        return None
    h, w = bgr.shape[:2]
    img = cv2.resize(bgr, (_INPUT, _INPUT), interpolation=cv2.INTER_AREA)
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    t = torch.from_numpy(img.transpose(2, 0, 1)).unsqueeze(0)
    with torch.no_grad():
        out = net(t)[0].cpu().numpy()  # (10,) normalized xy in [0,1]
    pts = out.reshape(5, 2)
    if not np.all(np.isfinite(pts)):
        return None
    pts[:, 0] *= w
    pts[:, 1] *= h
    return pts.astype(np.float32)


# ── Classical backend ─────────────────────────────────────────────────────────

def _detect_classical(bgr: np.ndarray) -> Optional[np.ndarray]:
    """Find the white plate pentagon by brightness + shape."""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    blur = cv2.GaussianBlur(gray, (5, 5), 0)

    # The plate is among the brightest large objects. Otsu, then keep bright side.
    _, th = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if th.mean() > 127:                     # plate should be the minority bright blob
        th = cv2.bitwise_not(th)
    th = cv2.morphologyEx(th, cv2.MORPH_OPEN,  np.ones((3, 3), np.uint8))
    th = cv2.morphologyEx(th, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))

    cnts, _ = cv2.findContours(th, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None

    img_area = float(w * h)
    best = None
    for c in cnts:
        area = cv2.contourArea(c)
        if area < img_area * 0.004 or area > img_area * 0.9:
            continue
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) != 5 or not cv2.isContourConvex(approx):
            continue
        # Plate-ness: solidity high, roughly as wide as tall
        x, y, bw, bh = cv2.boundingRect(approx)
        ar = bw / float(bh) if bh else 0
        if ar < 0.5 or ar > 2.0:
            continue
        if best is None or area > best[0]:
            best = (area, approx)

    if best is None:
        return None
    pts = best[1].reshape(-1, 2).astype(np.float32)
    return _refine_subpix(gray, pts)


def _refine_subpix(gray: np.ndarray, pts: np.ndarray) -> np.ndarray:
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.01)
    p = pts.reshape(-1, 1, 2).astype(np.float32)
    cv2.cornerSubPix(gray, p, (5, 5), (-1, -1), crit)
    return p.reshape(-1, 2)


# ── Public API ────────────────────────────────────────────────────────────────

def detect_plate_corners(bgr: np.ndarray) -> Optional[np.ndarray]:
    """Return (5,2) float32 plate corner pixels, or None. Tries the learned
    model first, then the classical detector."""
    pts = _detect_cnn(bgr)
    if pts is not None:
        return pts
    return _detect_classical(bgr)


def using_learned_model() -> bool:
    torch, net = _try_load_model()
    return net is not None
