/**
 * Stereo triangulation compute shader (DLT method).
 *
 * One workgroup per detection pair.
 * Input:  detection_buffer — array of float4: (u0,v0, u1,v1) per pair
 * Input:  projection_uniforms — two 4×4 projection matrices P0, P1 (row-major)
 * Output: world_points_buffer — array of float4: (X, Y, Z, reprojError)
 */

struct ProjectionUniforms {
  P0 : array<vec4f, 4>,   // rows of 3x4 matrix P0 (padded to 4x4)
  P1 : array<vec4f, 4>,   // rows of 3x4 matrix P1 (padded to 4x4)
};

struct Detection {
  uv0 : vec2f,
  uv1 : vec2f,
};

@group(0) @binding(0) var<uniform>        proj      : ProjectionUniforms;
@group(0) @binding(1) var<storage, read>  detections: array<Detection>;
@group(0) @binding(2) var<storage, read_write> world_pts : array<vec4f>;

// 4×4 matrix–vector multiply (treating matrix as array of row vec4s)
fn mat4x4_mul_vec4(M: array<vec4f, 4>, v: vec4f) -> vec4f {
  return vec4f(
    dot(M[0], v),
    dot(M[1], v),
    dot(M[2], v),
    dot(M[3], v),
  );
}

// Build 4×4 A matrix from DLT constraints and solve via Jacobi SVD
// Returns homogeneous world point (4-vector, last component is w)
fn dlt_triangulate(u0: vec2f, u1: vec2f) -> vec4f {
  // Row 0: u0 * P0[2] - P0[0]
  let r0 = u0.x * proj.P0[2] - proj.P0[0];
  // Row 1: v0 * P0[2] - P0[1]
  let r1 = u0.y * proj.P0[2] - proj.P0[1];
  // Row 2: u1 * P1[2] - P1[0]
  let r2 = u1.x * proj.P1[2] - proj.P1[0];
  // Row 3: v1 * P1[2] - P1[1]
  let r3 = u1.y * proj.P1[2] - proj.P1[1];

  // Compute A^T * A (4×4 symmetric)
  // We use a simplified power-iteration to find the null vector (smallest singular vec)
  // Initial guess
  var v = vec4f(0.1, 0.3, 0.7, 0.9);
  let A = array<vec4f, 4>(r0, r1, r2, r3);

  // ATA rows
  var ATA: array<vec4f, 4>;
  for (var i = 0u; i < 4u; i++) {
    ATA[i] = vec4f(
      dot(A[0][i] * A[0] + A[1][i] * A[1] + A[2][i] * A[2] + A[3][i] * A[3], vec4f(1.0)),
      0.0, 0.0, 0.0
    );
  }
  // Build proper ATA
  for (var i = 0u; i < 4u; i++) {
    for (var j = 0u; j < 4u; j++) {
      ATA[i][j] = A[0][i]*A[0][j] + A[1][i]*A[1][j] + A[2][i]*A[2][j] + A[3][i]*A[3][j];
    }
  }

  // Power iteration (32 steps — converges for well-conditioned stereo geometry)
  for (var iter = 0u; iter < 32u; iter++) {
    let nv = mat4x4_mul_vec4(ATA, v);
    let n = length(nv);
    if (n < 1e-10) { break; }
    v = nv / n;
  }

  return v;
}

fn reproject_error(world: vec4f, uv: vec2f, P: array<vec4f, 4>) -> f32 {
  let h = mat4x4_mul_vec4(P, world);
  if (abs(h.z) < 1e-6) { return 999.0; }
  let px = h.x / h.z;
  let py = h.y / h.z;
  return length(vec2f(px, py) - uv);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= arrayLength(&detections)) { return; }

  let det = detections[idx];
  let homog = dlt_triangulate(det.uv0, det.uv1);

  let w = homog.w;
  if (abs(w) < 1e-8) {
    world_pts[idx] = vec4f(0.0, 0.0, 0.0, -1.0); // invalid
    return;
  }

  let world = vec3f(homog.x / w, homog.y / w, homog.z / w);
  let rpe0 = reproject_error(vec4f(world, 1.0), det.uv0, proj.P0);
  let rpe1 = reproject_error(vec4f(world, 1.0), det.uv1, proj.P1);

  world_pts[idx] = vec4f(world, (rpe0 + rpe1) * 0.5);
}
