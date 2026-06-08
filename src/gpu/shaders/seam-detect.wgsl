/**
 * Seam detection on cropped ball region.
 *
 * Input:  ball_crop — R8 grayscale texture (64×64 pixels)
 * Output: seam_result — vec4f (normal_x, normal_y, confidence, angle_rad)
 *
 * Algorithm:
 *   1. 8×8 workgroups compute Sobel edge + orientation per tile.
 *   2. Shared histogram accumulates orientation (36 bins × 5°).
 *   3. Find dominant orientation pair (seam great circle).
 *   4. Seam normal = perpendicular to dominant orientation.
 */

const HIST_BINS = 36u;          // 5° per bin, 0–180°
const TILE_SIZE = 8u;

struct SeamResult {
  normal_x   : f32,
  normal_y   : f32,
  confidence : f32,
  angle_rad  : f32,
};

@group(0) @binding(0) var                      ball_crop   : texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> seam_result : SeamResult;

var<workgroup> hist: array<atomic<u32>, HIST_BINS>;

fn load_pixel(x: i32, y: i32) -> f32 {
  let w = i32(textureDimensions(ball_crop).x);
  let h = i32(textureDimensions(ball_crop).y);
  let cx = clamp(x, 0, w - 1);
  let cy = clamp(y, 0, h - 1);
  return textureLoad(ball_crop, vec2u(u32(cx), u32(cy)), 0).r;
}

@compute @workgroup_size(TILE_SIZE, TILE_SIZE)
fn main(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_id)  lid: vec3u,
) {
  // Initialize histogram once per workgroup
  let lid_flat = lid.y * TILE_SIZE + lid.x;
  if (lid_flat < HIST_BINS) {
    atomicStore(&hist[lid_flat], 0u);
  }
  workgroupBarrier();

  let x = i32(gid.x);
  let y = i32(gid.y);
  let dim = textureDimensions(ball_crop);
  if (u32(x) >= dim.x || u32(y) >= dim.y) { return; }

  // Sobel 3×3
  let gx =
    -1.0 * load_pixel(x-1, y-1) + 1.0 * load_pixel(x+1, y-1) +
    -2.0 * load_pixel(x-1, y  ) + 2.0 * load_pixel(x+1, y  ) +
    -1.0 * load_pixel(x-1, y+1) + 1.0 * load_pixel(x+1, y+1);

  let gy =
     1.0 * load_pixel(x-1, y-1) + 2.0 * load_pixel(x, y-1) + 1.0 * load_pixel(x+1, y-1) +
    -1.0 * load_pixel(x-1, y+1) - 2.0 * load_pixel(x, y+1) - 1.0 * load_pixel(x+1, y+1);

  let magnitude = sqrt(gx * gx + gy * gy);
  if (magnitude < 0.08) { return; }  // ignore weak edges

  // Orientation [0, π) — edge direction perpendicular to gradient
  var angle = atan2(gy, gx);
  if (angle < 0.0) { angle += 3.14159265; }
  angle = angle % 3.14159265;

  let bin = u32(angle / 3.14159265 * f32(HIST_BINS)) % HIST_BINS;
  let weight = u32(magnitude * 255.0);
  atomicAdd(&hist[bin], weight);

  workgroupBarrier();

  // Only thread (0,0) writes the result
  if (lid_flat != 0u) { return; }

  // Find peak bin
  var peak_val = 0u;
  var peak_bin = 0u;
  for (var b = 0u; b < HIST_BINS; b++) {
    let v = atomicLoad(&hist[b]);
    if (v > peak_val) { peak_val = v; peak_bin = b; }
  }

  // Adjacent bins for weighted centroid
  let b_prev = (peak_bin + HIST_BINS - 1u) % HIST_BINS;
  let b_next = (peak_bin + 1u) % HIST_BINS;
  let v_prev = f32(atomicLoad(&hist[b_prev]));
  let v_curr = f32(peak_val);
  let v_next = f32(atomicLoad(&hist[b_next]));

  // Parabolic interpolation for sub-bin precision
  let offset = (v_next - v_prev) / (2.0 * (2.0 * v_curr - v_prev - v_next) + 1e-6);
  let refined_bin = f32(peak_bin) + offset;
  let seam_angle = refined_bin / f32(HIST_BINS) * 3.14159265;

  // Total histogram energy for confidence
  var total = 0u;
  for (var b = 0u; b < HIST_BINS; b++) { total += atomicLoad(&hist[b]); }
  let confidence = select(0.0, f32(peak_val) / f32(total), total > 0u);

  // Seam normal = perpendicular to seam direction
  let nx = -sin(seam_angle);
  let ny =  cos(seam_angle);

  seam_result.normal_x   = nx;
  seam_result.normal_y   = ny;
  seam_result.confidence = confidence;
  seam_result.angle_rad  = seam_angle;
}
