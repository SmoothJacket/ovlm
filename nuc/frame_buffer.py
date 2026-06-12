"""
Rolling frame-pair buffer with audio-triggered flush.

Stores the last BUFFER_DURATION_S of stereo frame pairs.
When trigger() is called, waits for HALF_WINDOW_S of post-trigger
frames then calls the flush callback with the ±window.
"""

import threading
import time
from collections import deque
from typing import Callable, List, Optional

import config
from capture import FramePair, SpinFrame

FlushCallback = Callable[[List[FramePair], float], None]


class FrameBuffer:
    def __init__(self, on_flush: FlushCallback) -> None:
        self._on_flush = on_flush
        self._ring: deque = deque()
        self._lock = threading.Lock()
        self._trigger_time: Optional[float] = None

    def push(self, pair: FramePair) -> None:
        now = time.monotonic()
        with self._lock:
            self._ring.append((now, pair))
            cutoff = now - config.BUFFER_DURATION_S
            while self._ring and self._ring[0][0] < cutoff:
                self._ring.popleft()

            if self._trigger_time is not None:
                elapsed = now - self._trigger_time
                if elapsed >= config.HALF_WINDOW_S:
                    self._flush_locked()

    def trigger(self, trigger_time: float) -> None:
        with self._lock:
            self._trigger_time = trigger_time

    def _flush_locked(self) -> None:
        t = self._trigger_time
        assert t is not None
        start = t - config.HALF_WINDOW_S
        end   = t + config.HALF_WINDOW_S

        window = [pair for (ts, pair) in self._ring if start <= ts <= end]
        self._trigger_time = None

        if window:
            # Hand off without holding the lock
            threading.Thread(
                target=self._on_flush,
                args=(window, t),
                daemon=True,
            ).start()

    def clear(self) -> None:
        with self._lock:
            self._ring.clear()
            self._trigger_time = None


class SpinFrameRing:
    """
    Rolling buffer for the optional spin camera. Unlike FrameBuffer it has no
    trigger logic of its own — the pipeline pulls the ±window around the same
    trigger timestamp that flushed the stereo buffer, keeping both cameras'
    windows aligned on the monotonic clock.
    """

    def __init__(self) -> None:
        self._ring: deque = deque()
        self._lock = threading.Lock()

    def push(self, sf: SpinFrame) -> None:
        with self._lock:
            self._ring.append(sf)
            cutoff = sf.timestamp - config.BUFFER_DURATION_S
            while self._ring and self._ring[0].timestamp < cutoff:
                self._ring.popleft()

    def window(self, start: float, end: float) -> List[SpinFrame]:
        with self._lock:
            return [sf for sf in self._ring if start <= sf.timestamp <= end]

    def clear(self) -> None:
        with self._lock:
            self._ring.clear()
