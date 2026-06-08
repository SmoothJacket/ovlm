"""
Microphone-based bat-crack trigger.

Monitors RMS amplitude in real time. When it crosses the threshold the
callback fires with the wall-clock time of the transient.

Public API used by the server for live streaming:
  trigger.current_rms   — latest RMS sample (0-1)
  trigger.peak_rms      — decaying peak (0-1, 1-second decay)
  trigger.threshold     — current trigger threshold
  trigger.set_threshold(v) — update threshold without restart
"""

import threading
import time
from typing import Callable, Optional

import numpy as np

import config

try:
    import pyaudio
    PYAUDIO_AVAILABLE = True
except ImportError:
    PYAUDIO_AVAILABLE = False

TriggerCallback = Callable[[float], None]   # wall time in seconds

# Peak decays to ~7 % of its value over ~1 second (512 samples / 44100 Hz ≈ 11.6 ms/chunk)
_PEAK_DECAY = 0.97


class AudioTrigger:
    def __init__(self, on_trigger: TriggerCallback) -> None:
        self._on_trigger = on_trigger
        self._armed      = False
        self._running    = False
        self._last_trigger = 0.0
        self._pa: Optional[object]     = None
        self._stream: Optional[object] = None
        self._thread: Optional[threading.Thread] = None

        self._lock      = threading.Lock()
        self._rms       = 0.0
        self._peak      = 0.0
        self._threshold = config.AUDIO_RMS_THRESHOLD

    # ── Public reads (thread-safe) ────────────────────────────────────────────
    @property
    def current_rms(self) -> float:
        with self._lock:
            return self._rms

    @property
    def peak_rms(self) -> float:
        with self._lock:
            return self._peak

    @property
    def threshold(self) -> float:
        return self._threshold

    def set_threshold(self, value: float) -> None:
        self._threshold = max(0.01, min(1.0, float(value)))

    # ── Lifecycle ─────────────────────────────────────────────────────────────
    def start(self) -> None:
        if not PYAUDIO_AVAILABLE:
            raise RuntimeError("pyaudio is not installed. Run: pip install pyaudio")

        self._pa = pyaudio.PyAudio()
        self._stream = self._pa.open(
            rate=config.AUDIO_SAMPLE_RATE,
            channels=1,
            format=pyaudio.paInt16,
            input=True,
            input_device_index=config.AUDIO_DEVICE_INDEX,
            frames_per_buffer=config.AUDIO_CHUNK,
        )
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def arm(self) -> None:
        self._armed = True

    def disarm(self) -> None:
        self._armed = False

    def stop(self) -> None:
        self._running = False
        if self._stream:
            self._stream.stop_stream()
            self._stream.close()
        if self._pa:
            self._pa.terminate()

    # ── Capture loop ──────────────────────────────────────────────────────────
    def _loop(self) -> None:
        max_int16 = 32768.0  # noqa: F841 — used in rms calculation below
        while self._running:
            data    = self._stream.read(config.AUDIO_CHUNK, exception_on_overflow=False)
            samples = np.frombuffer(data, dtype=np.int16)
            rms     = float(np.sqrt(np.mean(samples.astype(np.float64) ** 2))) / max_int16

            with self._lock:
                self._rms  = rms
                self._peak = rms if rms > self._peak else self._peak * _PEAK_DECAY

            if not self._armed:
                continue

            now = time.monotonic()
            if rms >= self._threshold:
                if now - self._last_trigger >= config.AUDIO_DEBOUNCE_S:
                    self._last_trigger = now
                    self._on_trigger(now)
