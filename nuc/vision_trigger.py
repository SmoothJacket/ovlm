"""
Camera-only "ball entered the frame" trigger — a stand-in for the radar
trigger (config.RADAR_ENABLED) until the IWR6843 board is wired up.

Runs detect.py's MOG2 + HoughCircles detector on every Nth live frame from
camera 0. The background model keeps learning regardless of armed state, so
it's already warmed up the moment you arm; a detection only fires the
callback while armed.

Less robust than radar — a person or bat moving through frame can also
register as a "ball" — but needs no extra hardware. Fed frames from
main.py's existing stereo capture rather than opening its own camera.
"""

import time
from typing import Callable

import numpy as np

import config
from detect import BallDetector

TriggerCallback = Callable[[float], None]   # monotonic time in seconds


class VisionTrigger:
    def __init__(self, on_trigger: TriggerCallback) -> None:
        self._on_trigger    = on_trigger
        self._armed         = False
        self._detector       = BallDetector()
        self._last_trigger  = 0.0
        self._frame_count   = 0

    def arm(self) -> None:
        self._armed = True

    def disarm(self) -> None:
        self._armed = False

    def reset_background(self) -> None:
        """Force the MOG2 model to relearn the empty scene — call this if
        lighting changed or something static moved into frame."""
        self._detector.reset()

    def feed(self, frame_bgr: np.ndarray) -> None:
        """Call once per live frame (camera 0) from the capture thread."""
        self._frame_count += 1
        if self._frame_count % config.VISION_TRIGGER_EVERY_NTH != 0:
            return

        det = self._detector.detect(frame_bgr)
        if det is None or not self._armed:
            return

        now = time.monotonic()
        if now - self._last_trigger < config.VISION_TRIGGER_DEBOUNCE_S:
            return
        self._last_trigger = now
        self._on_trigger(now)
