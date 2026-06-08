/**
 * Trajectory rendering — procedural tube geometry from point array.
 *
 * Vertex shader: expands each trajectory segment into a screen-space quad.
 * Fragment shader: color-maps by normalized velocity (blue=slow, red=fast).
 *
 * Uniforms: view-projection matrix, point buffer, velocity buffer.
 */

struct Uniforms {
  view_proj : mat4x4f,
  max_velocity : f32,   // mph — for color normalization
  tube_radius  : f32,   // world-space tube radius in meters
  point_count  : u32,
  _pad         : f32,
};

struct TrajectoryPoint {
  position : vec3f,
  velocity : f32,       // mph at this point
};

@group(0) @binding(0) var<uniform>       uniforms : Uniforms;
@group(0) @binding(1) var<storage, read> points   : array<TrajectoryPoint>;

struct VertexOut {
  @builtin(position) clip_pos  : vec4f,
  @location(0)       velocity  : f32,
  @location(1)       alpha     : f32,
};

// Turbo colormap approximation (velocity 0→1 = blue→red)
fn turbo(t: f32) -> vec3f {
  let r = 0.1357 + t * (4.5974 - t * (42.3277 - t * (130.5887 - t * (150.5666 - t * 58.1375))));
  let g = 0.0914 + t * (2.1856 + t * (4.8052 - t * (14.0195 + t * (4.2109 - t * 2.9115))));
  let b = 0.1067 + t * (1.5276 + t * (14.978 - t * (91.5437 - t * (138.6684 - t * 62.3552))));
  return clamp(vec3f(r, g, b), vec3f(0.0), vec3f(1.0));
}

@vertex
fn vs_main(
  @builtin(vertex_index) vi: u32,
) -> VertexOut {
  // Each segment = 2 points → 6 vertices (2 triangles)
  let seg_idx = vi / 6u;
  let vert_in_seg = vi % 6u;

  if (seg_idx + 1u >= uniforms.point_count) {
    var out: VertexOut;
    out.clip_pos = vec4f(0.0, 0.0, -1.0, 1.0); // clip away
    out.velocity = 0.0;
    out.alpha = 0.0;
    return out;
  }

  let p0 = points[seg_idx];
  let p1 = points[seg_idx + 1u];

  // Quad corners: 0,1,2 and 2,1,3
  let corner_indices = array<u32, 6>(0u, 1u, 2u, 2u, 1u, 3u);
  let ci = corner_indices[vert_in_seg];

  let which_point = ci / 2u; // 0 = p0 side, 1 = p1 side
  let which_side  = ci % 2u; // 0 = left, 1 = right

  let pos = select(p0.position, p1.position, which_point == 1u);
  let vel = select(p0.velocity,  p1.velocity,  which_point == 1u);

  // Billboard tube: offset perpendicular to view direction
  let clip = uniforms.view_proj * vec4f(pos, 1.0);
  let offset = select(-uniforms.tube_radius, uniforms.tube_radius, which_side == 1u);

  var out: VertexOut;
  out.clip_pos = clip + vec4f(offset / clip.w, 0.0, 0.0, 0.0);
  out.velocity = vel / uniforms.max_velocity;
  // Fade older points
  out.alpha = min(1.0, f32(seg_idx) / f32(uniforms.point_count) * 2.0);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let col = turbo(clamp(in.velocity, 0.0, 1.0));
  return vec4f(col, in.alpha * 0.9);
}
