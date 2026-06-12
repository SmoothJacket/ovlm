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
}

let simWindow: Window | null = null;
let simReady = false;
const queue: SimHitPayload[] = [];

// Embedded sim (iframe inside the 3D VIEW panel). Same protocol as the popup —
// the sim posts 'ovlm:sim-ready' to window.parent, hits queue until then.
let embedWindow: Window | null = null;
let embedReady = false;
const embedQueue: SimHitPayload[] = [];

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
  return {
    type: 'ovlm:hit',
    exitVelocity: ball.exitVelocity,
    launchAngle: ball.launchAngle,
    sprayAngle: ball.sprayAngle,
    backspin,
    sidespin,
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

/** Wire the bridge: ready-handshake listener + auto-forwarding of new swings
 *  (when enabled AND the sim window is already open — auto-open would be
 *  popup-blocked). Call once at app start. */
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

  let lastTopId: string | null = useStore.getState().swings[0]?.id ?? null;
  useStore.subscribe((state) => {
    const top = state.swings[0];
    if (!top || top.id === lastTopId) return;
    lastTopId = top.id;
    sendSwingToEmbed(top.ball); // embedded sim always mirrors live swings
    if (getAutoSend() && isSimulatorOpen()) sendSwingToSimulator(top.ball);
  });
}
