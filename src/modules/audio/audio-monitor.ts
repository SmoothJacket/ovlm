/**
 * Audio Monitor — Web Audio API bat-crack detection.
 *
 * Uses an AnalyserNode for RMS level monitoring and peak detection.
 * When RMS crosses the threshold, a 'triggered' event fires with the
 * precise AudioContext timestamp of the peak.
 *
 * Designed to run on the main thread and notify the frame-buffer module
 * to flush the ±0.5s window around the trigger point.
 */

export interface AudioMonitorOptions {
  /** Peak amplitude threshold 0-1 (default 0.6) */
  threshold?: number;
  /** After a trigger, ignore audio for this many ms (debounce) */
  debouncems?: number;
  /** FFT size for analyser (default 2048) */
  fftSize?: number;
}

export type AudioTriggerCallback = (timestamp: number, peakAmplitude: number) => void;
export type AudioLevelCallback = (rms: number, peak: number) => void;

export class AudioMonitor {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private rafId: number | null = null;
  private dataBuffer: Float32Array = new Float32Array(0);
  private armed = false;
  private lastTriggerTime = 0;

  private readonly threshold: number;
  private readonly debounceMs: number;
  private readonly fftSize: number;
  private onTrigger: AudioTriggerCallback | null = null;
  private onLevel: AudioLevelCallback | null = null;

  constructor(opts: AudioMonitorOptions = {}) {
    this.threshold = opts.threshold ?? 0.6;
    this.debounceMs = opts.debouncems ?? 500;
    this.fftSize = opts.fftSize ?? 2048;
  }

  async start(
    onTrigger: AudioTriggerCallback,
    onLevel?: AudioLevelCallback
  ): Promise<void> {
    this.onTrigger = onTrigger;
    this.onLevel = onLevel ?? null;

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.ctx = new AudioContext({ sampleRate: 48000 });
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = this.fftSize;
    this.analyser.smoothingTimeConstant = 0;

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.analyser);

    this.dataBuffer = new Float32Array(this.analyser.fftSize);
    this.armed = true;
    this._poll();
  }

  arm(): void { this.armed = true; }
  disarm(): void { this.armed = false; }

  setThreshold(threshold: number): void {
    (this as unknown as { threshold: number }).threshold = threshold;
  }

  stop(): void {
    this.armed = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.ctx = null;
    this.analyser = null;
    this.source = null;
    this.stream = null;
  }

  private _poll = (): void => {
    if (!this.analyser || !this.ctx) return;
    this.rafId = requestAnimationFrame(this._poll);

    this.analyser.getFloatTimeDomainData(this.dataBuffer as Float32Array<ArrayBuffer>);

    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < this.dataBuffer.length; i++) {
      const v = Math.abs(this.dataBuffer[i]);
      if (v > peak) peak = v;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / this.dataBuffer.length);

    this.onLevel?.(rms, peak);

    if (this.armed && peak >= this.threshold) {
      const now = this.ctx.currentTime * 1000; // ms
      if (now - this.lastTriggerTime > this.debounceMs) {
        this.lastTriggerTime = now;
        this.onTrigger?.(now, peak);
      }
    }
  };
}
