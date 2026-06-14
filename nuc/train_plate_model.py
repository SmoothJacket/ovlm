"""
Train the home-plate corner detector (PlateKeypointNet) on synthetic data.

No real images or manual labelling needed: we render regulation home plates over
randomised backgrounds at random perspective, scale, lighting, blur, noise,
dirt and partial occlusion, with exact ground-truth corner positions. The model
learns to regress the 5 corners in canonical order [FL, FR, MR, BP, ML], which
plate_detector.py then feeds to plate_calib.py.

    python train_plate_model.py                 # train, save plate_keypoints.pt
    python train_plate_model.py --steps 4000 --batch 64
    python train_plate_model.py --preview 12    # dump sample synth images, no training

Requires torch (pip install torch). CPU works; a GPU is much faster.
"""

from __future__ import annotations

import argparse
import os

import cv2
import numpy as np

import config

INPUT = 192   # must match plate_detector._INPUT and the model's expected size

# Template plate (top-down, inches), canonical order [FL, FR, MR, BP, ML]
_HALF = config.PLATE_FRONT_IN / 2.0
_TEMPLATE = np.array([
    [-_HALF, 0.0],                                   # FL
    [ _HALF, 0.0],                                   # FR
    [ _HALF, config.PLATE_SIDE_IN],                  # MR
    [ 0.0,   config.PLATE_SIDE_IN + config.PLATE_BACK_IN],  # BP
    [-_HALF, config.PLATE_SIDE_IN],                  # ML
], dtype=np.float32)


# ── Synthetic sample generation ───────────────────────────────────────────────

def _random_background(rng) -> np.ndarray:
    base = rng.integers(0, 90, size=3) if rng.random() < 0.6 else rng.integers(60, 200, size=3)
    img = np.full((INPUT, INPUT, 3), base, dtype=np.uint8)
    # gradient
    if rng.random() < 0.7:
        g = np.linspace(rng.integers(-40, 40), rng.integers(-40, 40), INPUT).astype(np.int16)
        img = np.clip(img.astype(np.int16) + g[:, None, None], 0, 255).astype(np.uint8)
    # grassy green sometimes
    if rng.random() < 0.4:
        img[:, :, 1] = np.clip(img[:, :, 1].astype(np.int16) + rng.integers(20, 70), 0, 255).astype(np.uint8)
    # clutter: random lines / blobs
    for _ in range(rng.integers(0, 8)):
        c = tuple(int(v) for v in rng.integers(0, 255, 3))
        p1 = tuple(int(v) for v in rng.integers(0, INPUT, 2))
        p2 = tuple(int(v) for v in rng.integers(0, INPUT, 2))
        if rng.random() < 0.5:
            cv2.line(img, p1, p2, c, int(rng.integers(1, 4)))
        else:
            cv2.circle(img, p1, int(rng.integers(3, 25)), c, -1)
    img = (img.astype(np.float32) + rng.normal(0, rng.uniform(2, 14), img.shape)).clip(0, 255).astype(np.uint8)
    return img


def _place_plate(rng):
    """Random homography that maps the template plate into the image, returns the
    5 corner pixel positions (canonical order) and the fill polygon."""
    # Normalise template to a unit-ish quad, then map its bbox to a random quad.
    t = _TEMPLATE.copy()
    t -= t.min(axis=0)
    t /= t.max(axis=0).max()                          # 0..1 box
    src_box = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], dtype=np.float32)

    margin = 18
    lo, hi = margin, INPUT - margin
    # random destination quad (perspective), kept inside the frame
    for _ in range(20):
        scale = rng.uniform(0.35, 0.9) * (hi - lo)
        cx, cy = rng.uniform(lo + scale * 0.3, hi - scale * 0.3, size=2)
        jitter = scale * 0.28
        dst = np.array([
            [cx - scale / 2, cy - scale / 2],
            [cx + scale / 2, cy - scale / 2],
            [cx + scale / 2, cy + scale / 2],
            [cx - scale / 2, cy + scale / 2],
        ], dtype=np.float32)
        dst += rng.uniform(-jitter, jitter, dst.shape).astype(np.float32)
        if dst.min() >= 2 and dst.max() <= INPUT - 2:
            break
    else:
        return None, None
    H = cv2.getPerspectiveTransform(src_box, dst)
    tp = cv2.perspectiveTransform(t.reshape(-1, 1, 2), H).reshape(-1, 2)
    if tp.min() < 1 or tp.max() > INPUT - 1:
        return None, None
    return tp.astype(np.float32), tp.astype(np.int32)


def synth_sample(rng):
    for _ in range(8):
        corners, poly = _place_plate(rng)
        if corners is not None:
            break
    else:
        # fallback: centred plate
        corners = (_TEMPLATE - _TEMPLATE.mean(0)) * 4 + INPUT / 2
        poly = corners.astype(np.int32)

    img = _random_background(rng)
    white = int(rng.integers(170, 255))
    color = (white, white, int(np.clip(white + rng.integers(-15, 8), 0, 255)))
    cv2.fillPoly(img, [poly], color)
    cv2.polylines(img, [poly], True, tuple(int(c * 0.7) for c in color), 1)

    # dirt / scuffs on the plate
    for _ in range(rng.integers(0, 5)):
        p = tuple(int(v) for v in (corners.mean(0) + rng.uniform(-20, 20, 2)))
        cv2.circle(img, p, int(rng.integers(1, 6)), tuple(int(v) for v in rng.integers(40, 130, 3)), -1)

    # occlusion
    if rng.random() < 0.25:
        x, y = rng.integers(0, INPUT, 2)
        w, h = rng.integers(8, 40, 2)
        img[y:y + h, x:x + w] = rng.integers(0, 255, 3)

    # blur + noise + brightness
    if rng.random() < 0.5:
        k = int(rng.choice([3, 5]))
        img = cv2.GaussianBlur(img, (k, k), 0)
    if rng.random() < 0.4:
        img = (img.astype(np.float32) * rng.uniform(0.6, 1.3)).clip(0, 255).astype(np.uint8)

    target = (corners / INPUT).reshape(-1).astype(np.float32)   # 10 values, [0,1]
    return img, target


# ── Training ──────────────────────────────────────────────────────────────────

def train(steps: int, batch: int, lr: float, out: str) -> None:
    import torch
    from plate_model import PlateKeypointNet

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Training on {dev}  |  {steps} steps × batch {batch}")
    net = PlateKeypointNet().to(dev)
    opt = torch.optim.Adam(net.parameters(), lr=lr)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, steps)
    lossf = torch.nn.SmoothL1Loss()
    rng = np.random.default_rng()

    net.train()
    run = 0.0
    for step in range(1, steps + 1):
        imgs = np.empty((batch, 3, INPUT, INPUT), np.float32)
        tgts = np.empty((batch, 10), np.float32)
        for i in range(batch):
            im, tg = synth_sample(rng)
            imgs[i] = cv2.cvtColor(im, cv2.COLOR_BGR2RGB).transpose(2, 0, 1) / 255.0
            tgts[i] = tg
        x = torch.from_numpy(imgs).to(dev)
        y = torch.from_numpy(tgts).to(dev)
        opt.zero_grad()
        loss = lossf(net(x), y)
        loss.backward()
        opt.step(); sched.step()
        run += loss.item()
        if step % 50 == 0:
            px = (run / 50) ** 0.5 * INPUT          # rough px error proxy
            print(f"  step {step:5d}/{steps}  loss {run/50:.5f}  (~{px:.1f}px)")
            run = 0.0

    torch.save(net.state_dict(), out)
    print(f"Saved → {out}")


def preview(n: int) -> None:
    rng = np.random.default_rng()
    os.makedirs("plate_synth_preview", exist_ok=True)
    for i in range(n):
        img, tg = synth_sample(rng)
        c = (tg.reshape(5, 2) * INPUT).astype(int)
        for j, p in enumerate(c):
            cv2.circle(img, tuple(p), 3, (0, 165, 255), -1)
            cv2.putText(img, str(j), tuple(p + 4), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 165, 255), 1)
        cv2.imwrite(f"plate_synth_preview/sample_{i:02d}.png", img)
    print(f"Wrote {n} samples to plate_synth_preview/")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Train the OVLM plate keypoint model")
    ap.add_argument("--steps", type=int, default=3000)
    ap.add_argument("--batch", type=int, default=48)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--out", default=config.PLATE_MODEL_FILE)
    ap.add_argument("--preview", type=int, default=0, help="Dump N synthetic samples and exit")
    args = ap.parse_args()
    if args.preview:
        preview(args.preview)
    else:
        train(args.steps, args.batch, args.lr, args.out)
