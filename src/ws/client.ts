/**
 * WebSocket client — connects to the Pi pipeline server.
 *
 * Auto-reconnects with exponential backoff (1s → 2s → 4s → … → 30s cap).
 * Parses incoming Pi messages and pushes them into the Zustand store.
 */

import type { PiMessage, BrowserMessage } from './messages';

type StoreRef = {
  updatePipelineStatus: (patch: Record<string, unknown>) => void;
  ingestPiMeasurement: (msg: Extract<PiMessage, { type: 'measurement' }>) => void;
  updateAudioLevel: (level: Extract<PiMessage, { type: 'audio_level' }>) => void;
  updatePiHealth:   (h: Extract<PiMessage, { type: 'health' }>) => void;
  setLastFrame: (frame: Extract<PiMessage, { type: 'calib_frame' }>) => void;
  setCalibWizardResult: (r: Extract<PiMessage, { type: 'calib_result' }>) => void;
  setWizardStep: (step: 0 | 1 | 2 | 3) => void;
  updateCalibrationProgress: (msg: Extract<PiMessage, { type: 'calibration' }>) => void;
};

const BACKOFF_CAP_MS = 30_000;

class PiClient {
  private ws: WebSocket | null = null;
  private store: StoreRef | null = null;
  private url = '';
  private backoff = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;

  /** Call once from App on mount. */
  connect(url: string, store: StoreRef): void {
    this.url   = url;
    this.store = store;
    this.intentionallyClosed = false;
    this._open();
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
    this.store?.updatePipelineStatus({ wsConnected: false, state: 'idle' });
  }

  send(msg: BrowserMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private _open(): void {
    if (!this.url) return;

    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this._scheduleRetry();
      return;
    }

    this.ws.onopen = () => {
      this.backoff = 1000;
      this.store?.updatePipelineStatus({ wsConnected: true, errorMessage: undefined });
    };

    this.ws.onclose = () => {
      this.store?.updatePipelineStatus({ wsConnected: false });
      if (!this.intentionallyClosed) this._scheduleRetry();
    };

    this.ws.onerror = () => {
      this.store?.updatePipelineStatus({
        wsConnected: false,
        errorMessage: `Cannot reach launch monitor at ${this.url}`,
      });
    };

    this.ws.onmessage = (ev: MessageEvent<string>) => {
      let msg: PiMessage;
      try {
        msg = JSON.parse(ev.data) as PiMessage;
      } catch {
        return;
      }
      this._handle(msg);
    };
  }

  private _handle(msg: PiMessage): void {
    if (!this.store) return;
    switch (msg.type) {
      case 'status':
        this.store.updatePipelineStatus({
          state: msg.state,
          audioArmed: msg.audioArmed ?? false,
        });
        break;
      case 'measurement':
        this.store.ingestPiMeasurement(msg);
        break;
      case 'audio_level':
        this.store.updateAudioLevel(msg);
        break;
      case 'health':
        this.store.updatePiHealth(msg);
        break;
      case 'calibration':
        this.store.updateCalibrationProgress(msg);
        break;
      case 'error':
        this.store.updatePipelineStatus({ errorMessage: msg.message });
        break;
      case 'calib_frame':
        this.store.setLastFrame(msg);
        break;
      case 'calib_result':
        this.store.setCalibWizardResult(msg);
        this.store.setWizardStep(msg.ok ? 3 : 1);
        break;
    }
  }

  private _scheduleRetry(): void {
    this.retryTimer = setTimeout(() => {
      this.backoff = Math.min(this.backoff * 2, BACKOFF_CAP_MS);
      this._open();
    }, this.backoff);
  }
}

export const piClient = new PiClient();
