/**
 * WebGPU device singleton.
 * Provides a shared GPUDevice and GPUQueue for all GPU modules.
 * Falls back gracefully when WebGPU is unavailable.
 */

export interface GPUContext {
  device: GPUDevice;
  queue: GPUQueue;
  adapter: GPUAdapter;
}

let _ctx: GPUContext | null = null;
let _available: boolean | null = null;

export async function initGPU(): Promise<GPUContext | null> {
  if (_available === false) return null;
  if (_ctx) return _ctx;

  if (!navigator.gpu) {
    _available = false;
    console.warn('[OVLM] WebGPU not available — falling back to CPU pipeline');
    return null;
  }

  try {
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });
    if (!adapter) {
      _available = false;
      return null;
    }

    const device = await adapter.requestDevice({
      requiredFeatures: [],
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      },
    });

    device.lost.then((info: GPUDeviceLostInfo) => {
      console.error('[OVLM] GPUDevice lost:', info.message);
      _ctx = null;
      _available = null; // allow re-init attempt
    });

    _ctx = { device, queue: device.queue, adapter };
    _available = true;
    console.info('[OVLM] WebGPU initialized:', adapter.info?.description ?? 'unknown GPU');
    return _ctx;
  } catch (err) {
    console.error('[OVLM] WebGPU init failed:', err);
    _available = false;
    return null;
  }
}

export function getGPU(): GPUContext | null {
  return _ctx;
}

export function isGPUAvailable(): boolean {
  return _available === true && _ctx !== null;
}
