/**
 * Biomechanics Worker — MediaPipe Pose inference + biomech calculation.
 */

import type { BiomechRequest, BiomechResponse } from '@/types/worker-messages';
import type { PoseLandmarks } from '@/types/biomechanics';
import { MediaPipeBridge } from '@/modules/biomechanics/mediapipe-bridge';
import { computeBiomechData } from '@/modules/biomechanics/biomech-calculator';

const bridge = new MediaPipeBridge();
const landmarkHistory: PoseLandmarks[] = [];

function post(msg: BiomechResponse): void {
  self.postMessage(msg);
}

self.addEventListener('message', async (event: MessageEvent<BiomechRequest>) => {
  const msg = event.data;

  switch (msg.type) {
    case 'INIT':
      try {
        await bridge.initialize();
        post({ type: 'READY' });
      } catch (err) {
        post({ type: 'ERROR', message: String(err) });
      }
      break;

    case 'PROCESS_FRAME': {
      const timestampMs = msg.frameIndex * (1000 / 960);
      try {
        const landmarks = bridge.detectFrame(msg.frame, timestampMs);
        if (landmarks) {
          landmarkHistory.push(landmarks);
          post({ type: 'LANDMARKS', landmarks, frameIndex: msg.frameIndex });
        }
      } catch (err) {
        post({ type: 'ERROR', message: String(err) });
      }
      break;
    }

    case 'COMPUTE_METRICS': {
      if (landmarkHistory.length < 3) {
        post({ type: 'ERROR', message: 'Insufficient landmark history' });
        break;
      }
      const data = computeBiomechData(landmarkHistory, msg.contactFrameIndex);
      post({ type: 'BIOMECH_RESULT', data });
      break;
    }

    case 'RESET':
      landmarkHistory.length = 0;
      break;
  }
});
