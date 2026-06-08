/**
 * Ball candidate detection via Difference-of-Gaussians blob detection.
 *
 * Input:  input_texture — R8 grayscale texture (downsampled 4×)
 * Output: candidates_buffer — array of vec4f (x, y, response, radius)
 *         candidate_count   — atomic counter
 *
 * Each workgroup (8×8 threads) covers a tile of the image.
 * Uses two-pass Gaussian blur in shared memory, then computes DoG response.
 */

const TILE = 8u;
const HALO = 4u;  // max kernel radius
const LOCAL_SIZE = TILE + 2u * HALO; // 16

struct FrameUniforms {
  width  : u32,
  height : u32,
  sigma1 : f32,   // inner Gaussian sigma (e.g. 2.0)
  sigma2 : f32,   // outer Gaussian sigma (e.g. 4.0)
  threshold : f32,
};

@group(0) @binding(0) var<uniform>              uniforms   : FrameUniforms;
@group(0) @binding(1) var                       input_tex  : texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write>  candidates : array<vec4f>;
@group(0) @binding(3) var<storage, read_write>  cand_count : atomic<u32>;

var<workgroup> tile_data: array<f32, LOCAL_SIZE * LOCAL_SIZE>;

fn gaussian_kernel(sigma: f32, r: i32) -> f32 {
  return exp(-f32(r * r) / (2.0 * sigma * sigma));
}

fn sample_pixel(x: i32, y: i32, w: i32, h: i32) -> f32 {
  let cx = clamp(x, 0, w - 1);
  let cy = clamp(y, 0, h - 1);
  return textureLoad(input_tex, vec2u(u32(cx), u32(cy)), 0).r;
}

@compute @workgroup_size(TILE, TILE)
fn main(
  @builtin(global_invocation_id)   gid  : vec3u,
  @builtin(local_invocation_id)    lid  : vec3u,
  @builtin(workgroup_id)           wgid : vec3u,
) {
  let W = i32(uniforms.width);
  let H = i32(uniforms.height);

  // Load tile + halo into shared memory
  let tile_x = i32(wgid.x * TILE);
  let tile_y = i32(wgid.y * TILE);
  let local_x = i32(lid.x);
  let local_y = i32(lid.y);

  // Each thread loads a 2×2 block of the halo region
  for (var dy = 0; dy < 2; dy++) {
    for (var dx = 0; dx < 2; dx++) {
      let lx = local_x * 2 + dx;
      let ly = local_y * 2 + dy;
      if (lx < i32(LOCAL_SIZE) && ly < i32(LOCAL_SIZE)) {
        let px = tile_x - i32(HALO) + lx;
        let py = tile_y - i32(HALO) + ly;
        tile_data[u32(ly * i32(LOCAL_SIZE) + lx)] = sample_pixel(px, py, W, H);
      }
    }
  }

  workgroupBarrier();

  let lx = local_x + i32(HALO);
  let ly = local_y + i32(HALO);
  let gx = i32(gid.x);
  let gy = i32(gid.y);

  if (gx >= W || gy >= H) { return; }

  // Separable Gaussian blur: 9-tap kernel (radius 4)
  var blur1 = 0.0;
  var blur2 = 0.0;
  var w1    = 0.0;
  var w2    = 0.0;

  for (var r = -4; r <= 4; r++) {
    let k1 = gaussian_kernel(uniforms.sigma1, r);
    let k2 = gaussian_kernel(uniforms.sigma2, r);
    let idx_x = u32(ly * i32(LOCAL_SIZE) + lx + r);
    let idx_y = u32((ly + r) * i32(LOCAL_SIZE) + lx);
    let vx = tile_data[idx_x];
    let vy = tile_data[idx_y];
    blur1 += k1 * vx; w1 += k1;
    blur2 += k2 * vx; w2 += k2;
  }
  blur1 /= w1;
  blur2 /= w2;

  let dog = blur1 - blur2; // positive DoG = bright blob on dark background

  if (dog > uniforms.threshold) {
    // Check local maximum (3×3 non-maxima suppression)
    var is_max = true;
    for (var dy = -1; dy <= 1 && is_max; dy++) {
      for (var dx = -1; dx <= 1 && is_max; dx++) {
        if (dx == 0 && dy == 0) { continue; }
        let ni = u32((ly + dy) * i32(LOCAL_SIZE) + lx + dx);
        if (tile_data[ni] >= dog) { is_max = false; }
      }
    }

    if (is_max) {
      let slot = atomicAdd(&cand_count, 1u);
      if (slot < arrayLength(&candidates)) {
        // Scale back to full-resolution coordinates (4× downsample)
        let fx = (f32(gx) + 0.5) * 4.0;
        let fy = (f32(gy) + 0.5) * 4.0;
        let est_radius = uniforms.sigma1 * 3.0 * 4.0; // rough ball radius estimate
        candidates[slot] = vec4f(fx, fy, dog, est_radius);
      }
    }
  }
}
