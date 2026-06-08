/**
 * Circular frame buffer keyed by timestamp.
 * Stores the last N milliseconds of frame pairs.
 * When audio trigger fires, flushes the ±windowMs window around the trigger.
 */

import type { FramePair } from '@/types/tracking';

export interface FrameBufferOptions {
  /** Total rolling buffer duration in ms (default 2000ms = 2s) */
  bufferDurationMs?: number;
  /** Window to flush around trigger: total = 2 * halfWindowMs (default ±500ms) */
  halfWindowMs?: number;
}

export interface BufferedFrame {
  pair: FramePair;
  wallTimeMs: number;
}

export type FlushCallback = (frames: FramePair[], contactWallTimeMs: number) => void;

export class FrameBuffer {
  private readonly ring: BufferedFrame[] = [];
  private readonly bufferDurationMs: number;
  private readonly halfWindowMs: number;
  private onFlush: FlushCallback | null = null;
  private pendingTriggerTime: number | null = null;

  constructor(opts: FrameBufferOptions = {}) {
    this.bufferDurationMs = opts.bufferDurationMs ?? 2000;
    this.halfWindowMs = opts.halfWindowMs ?? 500;
  }

  setFlushCallback(cb: FlushCallback): void {
    this.onFlush = cb;
  }

  /**
   * Push an incoming frame pair into the ring buffer.
   * Old frames outside the buffer window are evicted.
   */
  push(pair: FramePair): void {
    const wallTimeMs = performance.now();
    this.ring.push({ pair, wallTimeMs });

    // Evict frames older than buffer duration
    const cutoff = wallTimeMs - this.bufferDurationMs;
    while (this.ring.length > 0 && this.ring[0].wallTimeMs < cutoff) {
      this.ring.shift();
    }

    // If we have a pending trigger and enough post-trigger frames, flush
    if (this.pendingTriggerTime !== null) {
      const elapsed = wallTimeMs - this.pendingTriggerTime;
      if (elapsed >= this.halfWindowMs) {
        this._flush(this.pendingTriggerTime);
        this.pendingTriggerTime = null;
      }
    }
  }

  /**
   * Signal that audio trigger fired at this wall-clock time.
   * The flush will happen once sufficient post-trigger frames accumulate.
   */
  trigger(triggerWallTimeMs: number): void {
    this.pendingTriggerTime = triggerWallTimeMs;
  }

  private _flush(triggerTime: number): void {
    const start = triggerTime - this.halfWindowMs;
    const end   = triggerTime + this.halfWindowMs;

    const window = this.ring
      .filter((f) => f.wallTimeMs >= start && f.wallTimeMs <= end)
      .map((f) => f.pair);

    this.onFlush?.(window, triggerTime);
  }

  clear(): void {
    this.ring.length = 0;
    this.pendingTriggerTime = null;
  }
}
