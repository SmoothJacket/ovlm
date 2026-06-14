"""
PlateKeypointNet — small CNN that regresses the 5 home-plate corner positions.

Input : 3×192×192 RGB crop, values in [0,1]
Output: 10 values = 5 corners × (x, y), each normalized to [0,1] in image space,
        in canonical order [front-left, front-right, mid-right, back-point, mid-left].

Kept deliberately tiny (~1.1M params) so it runs on a NUC CPU in a few ms.
Imported by both plate_detector.py (inference) and train_plate_model.py (training).
"""

import torch
import torch.nn as nn


def _block(cin, cout):
    return nn.Sequential(
        nn.Conv2d(cin, cout, 3, padding=1, bias=False),
        nn.BatchNorm2d(cout),
        nn.ReLU(inplace=True),
        nn.Conv2d(cout, cout, 3, padding=1, bias=False),
        nn.BatchNorm2d(cout),
        nn.ReLU(inplace=True),
        nn.MaxPool2d(2),
    )


class PlateKeypointNet(nn.Module):
    def __init__(self, n_corners: int = 5):
        super().__init__()
        self.features = nn.Sequential(
            _block(3, 32),    # 192 → 96
            _block(32, 64),   # 96 → 48
            _block(64, 96),   # 48 → 24
            _block(96, 128),  # 24 → 12
            _block(128, 160), # 12 → 6
        )
        self.head = nn.Sequential(
            nn.AdaptiveAvgPool2d(1),
            nn.Flatten(),
            nn.Linear(160, 128),
            nn.ReLU(inplace=True),
            nn.Dropout(0.2),
            nn.Linear(128, n_corners * 2),
            nn.Sigmoid(),     # constrain to [0,1] image-normalized coords
        )

    def forward(self, x):
        return self.head(self.features(x))
