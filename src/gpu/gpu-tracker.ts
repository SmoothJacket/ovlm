/**
 * Orchestrates WebGPU compute dispatches for the tracking pipeline.
 * Manages GPU buffers, pipeline cache, and dispatch sequencing.
 */

import type { GPUContext } from './device';
import type { BallDetection2D, BallPoint3D } from '@/types/tracking';
import type { CalibrationData } from '@/types/calibration';

import triangulateWGSL from './shaders/triangulate.wgsl?raw';
import ballHeatmapWGSL from './shaders/ball-heatmap.wgsl?raw';
import seamDetectWGSL from './shaders/seam-detect.wgsl?raw';

const MAX_CANDIDATES = 16;
const BALL_CROP_SIZE = 64;

export class GPUTracker {
  private readonly ctx: GPUContext;
  private triPipeline: GPUComputePipeline | null = null;
  private heatmapPipeline: GPUComputePipeline | null = null;
  private seamPipeline: GPUComputePipeline | null = null;
  private projUniformBuffer: GPUBuffer | null = null;
  private initialized = false;

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
  }

  async initialize(calibration: CalibrationData): Promise<void> {
    const { device } = this.ctx;

    // Compile all pipelines in parallel
    const [triPipeline, heatmapPipeline, seamPipeline] = await Promise.all([
      device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: triangulateWGSL }), entryPoint: 'main' },
      }),
      device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: ballHeatmapWGSL }), entryPoint: 'main' },
      }),
      device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: seamDetectWGSL }), entryPoint: 'main' },
      }),
    ]);

    this.triPipeline = triPipeline;
    this.heatmapPipeline = heatmapPipeline;
    this.seamPipeline = seamPipeline;

    // Upload projection matrices
    this.projUniformBuffer = this._buildProjectionBuffer(calibration);
    this.initialized = true;
  }

  /**
   * Run ball-heatmap detection on a downsampled grayscale texture.
   * Returns candidate list [{x, y, response, radius}].
   */
  async detectCandidates(
    grayData: Uint8Array,
    width: number,
    height: number
  ): Promise<Array<{ x: number; y: number; radius: number }>> {
    if (!this.initialized || !this.heatmapPipeline) return [];
    const { device, queue } = this.ctx;

    // Upload grayscale texture
    const texture = device.createTexture({
      size: [width, height],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    queue.writeTexture({ texture }, grayData.buffer as ArrayBuffer, { bytesPerRow: width }, [width, height]);

    // Uniform buffer: width, height, sigma1=2, sigma2=4, threshold=0.05
    const uniformData = new Float32Array([width, height, 2.0, 4.0, 0.05]);
    const uniformBuf = device.createBuffer({
      size: uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    queue.writeBuffer(uniformBuf, 0, uniformData);

    // Candidates output buffer
    const candidatesBuf = device.createBuffer({
      size: MAX_CANDIDATES * 4 * 4, // MAX_CANDIDATES vec4f
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const countBuf = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readBuf = device.createBuffer({
      size: MAX_CANDIDATES * 4 * 4 + 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    const bindGroup = device.createBindGroup({
      layout: this.heatmapPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuf } },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: { buffer: candidatesBuf } },
        { binding: 3, resource: { buffer: countBuf } },
      ],
    });

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.heatmapPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    enc.copyBufferToBuffer(candidatesBuf, 0, readBuf, 0, MAX_CANDIDATES * 16);
    enc.copyBufferToBuffer(countBuf, 0, readBuf, MAX_CANDIDATES * 16, 4);
    queue.submit([enc.finish()]);

    await readBuf.mapAsync(GPUMapMode.READ);
    const mapped = new Float32Array(readBuf.getMappedRange(0, MAX_CANDIDATES * 16));
    const countView = new Uint32Array(readBuf.getMappedRange(MAX_CANDIDATES * 16, 4));
    const count = Math.min(countView[0], MAX_CANDIDATES);

    const results: Array<{ x: number; y: number; radius: number }> = [];
    for (let i = 0; i < count; i++) {
      results.push({
        x: mapped[i * 4],
        y: mapped[i * 4 + 1],
        radius: mapped[i * 4 + 3],
      });
    }

    readBuf.unmap();
    texture.destroy(); uniformBuf.destroy(); candidatesBuf.destroy(); countBuf.destroy(); readBuf.destroy();

    return results;
  }

  /**
   * Triangulate a detection pair via GPU.
   * Returns a single BallPoint3D.
   */
  async triangulate(
    det0: BallDetection2D,
    det1: BallDetection2D,
    frameIndex: number
  ): Promise<BallPoint3D | null> {
    if (!this.initialized || !this.triPipeline || !this.projUniformBuffer) return null;
    const { device, queue } = this.ctx;

    const detectionData = new Float32Array([
      det0.center[0], det0.center[1],
      det1.center[0], det1.center[1],
    ]);
    const detBuf = device.createBuffer({
      size: detectionData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    queue.writeBuffer(detBuf, 0, detectionData);

    const outBuf = device.createBuffer({
      size: 4 * 4, // one vec4f
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readBuf = device.createBuffer({
      size: 4 * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    const bindGroup = device.createBindGroup({
      layout: this.triPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.projUniformBuffer } },
        { binding: 1, resource: { buffer: detBuf } },
        { binding: 2, resource: { buffer: outBuf } },
      ],
    });

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.triPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, 16);
    queue.submit([enc.finish()]);

    await readBuf.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(readBuf.getMappedRange());
    const [x, y, z, rpe] = result;
    readBuf.unmap();

    detBuf.destroy(); outBuf.destroy(); readBuf.destroy();

    if (rpe < 0) return null; // invalid marker

    return {
      x, y, z,
      timestamp: frameIndex * (1_000_000 / 960),
      disparity: Math.abs(det0.center[0] - det1.center[0]),
      reprojError: rpe,
    };
  }

  private _buildProjectionBuffer(cal: CalibrationData): GPUBuffer {
    const { device, queue } = this.ctx;

    // P0: K0 * [I|0]
    const P0 = [
      cal.cam0.fx, 0, cal.cam0.cx, 0,
      0, cal.cam0.fy, cal.cam0.cy, 0,
      0, 0, 1, 0,
      0, 0, 0, 0,
    ];

    // P1: K1 * [R|T]
    const R = cal.stereo.R;
    const T = cal.stereo.T;
    const fx = cal.cam1.fx, fy = cal.cam1.fy, cx = cal.cam1.cx, cy = cal.cam1.cy;
    const P1 = [
      fx*R[0]+cx*R[6], fx*R[1]+cx*R[7], fx*R[2]+cx*R[8], fx*T[0]+cx*T[2],
      fy*R[3]+cy*R[6], fy*R[4]+cy*R[7], fy*R[5]+cy*R[8], fy*T[1]+cy*T[2],
      R[6], R[7], R[8], T[2],
      0, 0, 0, 0,
    ];

    const data = new Float32Array([...P0, ...P1]);
    const buf = device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    queue.writeBuffer(buf, 0, data);
    return buf;
  }

  dispose(): void {
    this.projUniformBuffer?.destroy();
    this.projUniformBuffer = null;
    this.initialized = false;
  }
}
