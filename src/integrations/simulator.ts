/**
 * HitTrax simulator bridge — replays measured swings in the MLB stadium
 * simulator (baseball_simulator.html), which renders the full 3-D ball
 * flight from the unit's recorded metrics.
 *
 * Protocol:
 *   1. `openSimulator()` opens the sim in a named window (user gesture).
 *   2. When its stadiums finish loading, the sim posts
 *      `{ type: 'ovlm:sim-ready' }` back to this window.
 *   3. Each swing is sent as `{ type: 'ovlm:hit', exitVelocity, launchAngle,
 *      sprayAngle, backspin, sidespin }` via postMessage; payloads sent
 *      before the ready handshake are queued and flushed on ready.
 *
 * The sim clamps values to its slider ranges (EV 40–120 mph, LA −20–60°,
 * spray ±45°, backspin −1000–4000 rpm, sidespin ±2500 rpm).
 */

import { useStore } from '@/state/store';
import type { BallMeasurement } from '@/types/tracking';

const URL_KEY     = 'ovlm_sim_url';
const AUTO_KEY    = 'ovlm_sim_autosend';
// The sim ships in public/ and is served same-origin by Vite — no separate
// server. Migrate the stale pre-vendoring default; leave custom URLs alone.
const DEFAULT_URL = '/baseball_simulator.html';
const LEGACY_URL  = 'http://localhost:8080/baseball_simulator.html';

export interface SimHitPayload {
  type: 'ovlm:hit';
  exitVelocity: number;
  launchAngle: number;
  sprayAngle: number;
  backspin: number;
  sidespin: number;
  /** Contact point at the plate (feet). +X = first-base side, Y = height above ground. */
  contactXFt?: number;
  contactYFt?: number;
  /** Captured 3-D points in OVLM world frame (metres):
   *  +X = first base, +Y = up, +Z = toward the pitcher.
   *  The simulator projects these into its stadium frame and draws them as
   *  a cyan polyline so the operator can see the actual measured ball path
   *  on top of the simulated one. */
  trajectory?: Array<[number, number, number]>;
}

export interface SimPitchPayload {
  type: 'ovlm:pitch';
  releaseSpeedMph: number;
  plateSpeedMph: number;
  plateTimeS: number;
  plateLocXFt: number;
  plateLocYFt: number;
  releaseHeightFt: number;
  releaseSideFt: number;
  extensionFt: number;
  verticalBreakIn: number;
  horizontalBreakIn: number;
  vaaDeg: number;
  haaDeg: number;
  spinRateRpm?: number;
  spinTilt?: string;
  /** Percentage of spin that is gyro (0–80); undefined when not measured */
  gyroPct?: number;
  trajectory?: Array<[number, number, number]>;
}

type SimPayload = SimHitPayload | SimPitchPayload;

let simWindow: Window | null = null;
let simReady = false;
const queue: SimPayload[] = [];

// Embedded sim (iframe inside the 3D VIEW panel). Same protocol as the popup —
// the sim posts 'ovlm:sim-ready' to window.parent, hits queue until then.
let embedWindow: Window | null = null;
let embedReady = false;
const embedQueue: SimPayload[] = [];

export function getSimulatorUrl(): string {
  const saved = localStorage.getItem(URL_KEY);
  if (saved == null || saved === LEGACY_URL) return DEFAULT_URL;
  return saved;
}
export function setSimulatorUrl(url: string): void {
  localStorage.setItem(URL_KEY, url);
}

export function getAutoSend(): boolean {
  return localStorage.getItem(AUTO_KEY) === '1';
}
export function setAutoSend(on: boolean): void {
  localStorage.setItem(AUTO_KEY, on ? '1' : '0');
}

export function isSimulatorOpen(): boolean {
  return simWindow != null && !simWindow.closed;
}

/** Open (or focus) the simulator window. Call from a user gesture —
 *  browsers block window.open outside of one. */
export function openSimulator(): void {
  if (isSimulatorOpen()) {
    simWindow!.focus();
    return;
  }
  simReady = false;
  simWindow = window.open(getSimulatorUrl(), 'ovlm-simulator');
}

/** Convert a measured ball into the sim's hit payload. The seam spin vector
 *  (rpm + unit axis + efficiency) is decomposed: the vertical axis component
 *  becomes sidespin, the horizontal remainder backspin. */
export function ballToSimPayload(ball: BallMeasurement): SimHitPayload {
  let backspin = 1800; // typical batted-ball backspin when unmeasured
  let sidespin = 0;
  if (ball.seam) {
    const transverse = ball.seam.spinRate * (ball.seam.spinEfficiency || 0.9);
    const axY = ball.seam.spinAxis?.[1] ?? 0;
    sidespin = Math.round(-transverse * axY);
    backspin = Math.round(transverse * Math.sqrt(Math.max(0, 1 - axY * axY)));
  }
  const trajectory: SimHitPayload['trajectory'] = ball.trajectory?.length
    ? ball.trajectory.map((p) => [p.x, p.y, p.z])
    : undefined;
  return {
    type: 'ovlm:hit',
    exitVelocity: ball.exitVelocity,
    launchAngle: ball.launchAngle,
    sprayAngle: ball.sprayAngle,
    backspin,
    sidespin,
    contactXFt: ball.contactXFt,
    contactYFt: ball.contactYFt,
    trajectory,
  };
}

/** Convert a measured pitch into the sim's pitch payload. */
export function ballToPitchPayload(ball: BallMeasurement): SimPitchPayload {
  const p = ball.pitch!;
  const gyroPct =
    p.activeSpinPct != null
      ? Math.min(80, Math.round(100 - p.activeSpinPct))
      : undefined;
  const trajectory: SimPitchPayload['trajectory'] = ball.trajectory?.length
    ? ball.trajectory.map((pt) => [pt.x, pt.y, pt.z])
    : undefined;
  return {
    type: 'ovlm:pitch',
    releaseSpeedMph: p.releaseSpeedMph,
    plateSpeedMph: p.plateSpeedMph,
    plateTimeS: p.plateTimeS,
    plateLocXFt: p.plateLocXFt,
    plateLocYFt: p.plateLocYFt,
    releaseHeightFt: p.releaseHeightFt,
    releaseSideFt: p.releaseSideFt,
    extensionFt: p.extensionFt,
    verticalBreakIn: p.verticalBreakIn,
    horizontalBreakIn: p.horizontalBreakIn,
    vaaDeg: p.vaaDeg,
    haaDeg: p.haaDeg,
    spinRateRpm: p.spinRateRpm ?? undefined,
    spinTilt: p.spinTilt ?? undefined,
    gyroPct,
    trajectory,
  };
}

/** Register (or clear, with null) the embedded sim iframe's contentWindow.
 *  Call from the iframe's onLoad; the ready flag resets so hits queue until
 *  the freshly loaded document finishes its stadium preload. */
export function registerEmbed(win: Window | null): void {
  embedWindow = win;
  embedReady = false;
  embedQueue.length = 0;
}

export function isEmbedReady(): boolean {
  return embedReady;
}

/** Send one swing to the embedded sim iframe (queues until its ready
 *  handshake; no-op when no iframe is registered). */
export function sendSwingToEmbed(ball: BallMeasurement): void {
  if (!embedWindow) return;
  const payload = ballToSimPayload(ball);
  if (!embedReady) {
    embedQueue.push(payload);
    return;
  }
  embedWindow.postMessage(payload, '*');
}

/** Send one pitch to the embedded sim iframe (queues until its ready handshake). */
export function sendPitchToEmbed(ball: BallMeasurement): void {
  if (!embedWindow || !ball.pitch) return;
  const payload = ballToPitchPayload(ball);
  if (!embedReady) {
    embedQueue.push(payload);
    return;
  }
  embedWindow.postMessage(payload, '*');
}

/** Send one swing to the simulator. Opens the sim window if needed
 *  (only works from a user gesture); queues until the ready handshake. */
export function sendSwingToSimulator(ball: BallMeasurement): void {
  const payload = ballToSimPayload(ball);
  if (!isSimulatorOpen()) {
    queue.length = 0;
    queue.push(payload);
    openSimulator();
    return;
  }
  if (!simReady) {
    queue.push(payload);
    return;
  }
  simWindow!.postMessage(payload, '*');
}

/** Send one pitch to the popup simulator window. */
export function sendPitchToSimulator(ball: BallMeasurement): void {
  if (!ball.pitch) return;
  const payload = ballToPitchPayload(ball);
  if (!isSimulatorOpen()) {
    queue.length = 0;
    queue.push(payload);
    openSimulator();
    return;
  }
  if (!simReady) {
    queue.push(payload);
    return;
  }
  simWindow!.postMessage(payload, '*');
}

/** Wire the bridge: ready-handshake listener + auto-forwarding to both the
 *  embedded sim (always mirrors the active swing) and the popup window (when
 *  auto-send is on). Call once at app start. */
export function initSimulatorBridge(): void {
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.data?.type !== 'ovlm:sim-ready') return;
    if (embedWindow && e.source === embedWindow) {
      embedReady = true;
      for (const p of embedQueue.splice(0)) embedWindow.postMessage(p, '*');
      return;
    }
    simReady = true;
    for (const p of queue.splice(0)) simWindow?.postMessage(p, '*');
  });

  // Embedded sim always mirrors the active swing — covers both live arrivals
  // (activeSwingId updates when a new swing is ingested) and the user clicking
  // a past swing in the Metrics list.
  let lastActiveId: string | null = useStore.getState().activeSwingId ?? null;
  useStore.subscribe((state) => {
    const activeId = state.activeSwingId;
    if (!activeId || activeId === lastActiveId) return;
    lastActiveId = activeId;
    const sw = state.swings.find((s) => s.id === activeId);
    if (!sw) return;
    if (sw.ball.pitch) sendPitchToEmbed(sw.ball);
    else sendSwingToEmbed(sw.ball);
  });

  // Popup window: auto-forward new swings when the feature is enabled.
  let lastTopId: string | null = useStore.getState().swings[0]?.id ?? null;
  useStore.subscribe((state) => {
    const top = state.swings[0];
    if (!top || top.id === lastTopId) return;
    lastTopId = top.id;
    if (getAutoSend() && isSimulatorOpen()) {
      if (top.ball.pitch) sendPitchToSimulator(top.ball);
      else sendSwingToSimulator(top.ball);
    }
  });
}
