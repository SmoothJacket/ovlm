// Validation harness for nuc/trajectory.py's robust ballistic fitter.
// Replicates the Python algorithm step-for-step in JS (no numpy on this
// machine) and compares it against the old 2-point finite-difference method
// on synthetic trajectories with known ground truth.
//
// Run: node test_trajectory_fit.mjs

// ── Constants matching nuc/config.py ─────────────────────────────────────────
const GRAVITY = 9.81;
const AIR_DENSITY = 1.225;
const BALL_MASS = 0.1417;
const BALL_DIAMETER = 0.0737;
const DRAG_COEFF = 0.35;
const DRAG_K = 0.5 * AIR_DENSITY * DRAG_COEFF * Math.PI * (BALL_DIAMETER / 2) ** 2 / BALL_MASS;
const MPH = 2.23694;

const FPS = 120;
const NOISE_M = 0.005;        // 5 mm triangulation noise (1σ per axis)
const OUTLIER_RATE = 0.08;    // 8 % of detections are garbage
const DROP_RATE = 0.15;       // 15 % of frames missed
const FLIGHT_S = 0.25;        // ball visible for 250 ms

// ── Deterministic RNG (mulberry32) + Box-Muller gaussian ─────────────────────
let seed = 42;
function rand() {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function gauss() {
  const u = Math.max(rand(), 1e-12), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ── Ground-truth trajectory: RK4 with drag + gravity ─────────────────────────
function simulate(evMph, laDeg, saDeg) {
  const v0 = evMph / MPH;
  const la = (laDeg * Math.PI) / 180, sa = (saDeg * Math.PI) / 180;
  let s = [0, 1.0, 0,                                  // start 1 m off the ground
    v0 * Math.cos(la) * Math.sin(sa),
    v0 * Math.sin(la),
    v0 * Math.cos(la) * Math.cos(sa)];
  const deriv = (st) => {
    const sp = Math.hypot(st[3], st[4], st[5]) + 1e-12;
    return [st[3], st[4], st[5],
      -DRAG_K * sp * st[3], -GRAVITY - DRAG_K * sp * st[4], -DRAG_K * sp * st[5]];
  };
  const pts = [];
  const dt = 1 / FPS;
  const n = Math.round(FLIGHT_S * FPS);
  for (let i = 0; i <= n; i++) {
    pts.push({ t: i * dt, x: s[0], y: s[1], z: s[2] });
    // RK4 step
    const k1 = deriv(s);
    const s2 = s.map((v, j) => v + (dt / 2) * k1[j]); const k2 = deriv(s2);
    const s3 = s.map((v, j) => v + (dt / 2) * k2[j]); const k3 = deriv(s3);
    const s4 = s.map((v, j) => v + dt * k3[j]);       const k4 = deriv(s4);
    s = s.map((v, j) => v + (dt / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
  }
  return pts;
}

function corrupt(pts) {
  const out = [];
  for (const p of pts) {
    if (rand() < DROP_RATE) continue;
    if (rand() < OUTLIER_RATE) {
      out.push({ t: p.t, x: p.x + (rand() - 0.5) * 2, y: p.y + (rand() - 0.5) * 2, z: p.z + (rand() - 0.5) * 2 });
    } else {
      out.push({ t: p.t, x: p.x + gauss() * NOISE_M, y: p.y + gauss() * NOISE_M, z: p.z + gauss() * NOISE_M });
    }
  }
  return out;
}

// ── OLD method: finite difference of first two points ────────────────────────
function fitOld(pts) {
  if (pts.length < 3) return null;
  const dt = Math.max(pts[1].t - pts[0].t, 1 / FPS);
  const vx = (pts[1].x - pts[0].x) / dt;
  const vy = (pts[1].y - pts[0].y) / dt;
  const vz = (pts[1].z - pts[0].z) / dt;
  return metricsFromV(vx, vy, vz);
}

// ── NEW method: replica of TrajectoryFitter.fit ───────────────────────────────
const MIN_POINTS = 3, QUAD_MIN_N = 8, OUT_SIGMA = 3.0, OUT_FLOOR = 0.010, MAX_ROUNDS = 3;

function lstsq(A, B) {
  // Solve (AᵀA)x = AᵀB for each column of B via Gaussian elimination
  const m = A.length, n = A[0].length, k = B[0].length;
  const AtA = Array.from({ length: n }, () => new Float64Array(n));
  const AtB = Array.from({ length: n }, () => new Float64Array(k));
  for (let i = 0; i < m; i++)
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) AtA[a][b] += A[i][a] * A[i][b];
      for (let c = 0; c < k; c++) AtB[a][c] += A[i][a] * B[i][c];
    }
  // Gaussian elimination with partial pivoting
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(AtA[r][col]) > Math.abs(AtA[piv][col])) piv = r;
    [AtA[col], AtA[piv]] = [AtA[piv], AtA[col]];
    [AtB[col], AtB[piv]] = [AtB[piv], AtB[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = AtA[r][col] / AtA[col][col];
      for (let c2 = 0; c2 < n; c2++) AtA[r][c2] -= f * AtA[col][c2];
      for (let c2 = 0; c2 < k; c2++) AtB[r][c2] -= f * AtB[col][c2];
    }
  }
  return AtB.map((row, i) => Array.from(row, (v) => v / AtA[i][i]));
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function fitNew(pts) {
  if (pts.length < MIN_POINTS) return null;
  pts = [...pts].sort((a, b) => a.t - b.t);
  const t0 = pts[0].t;
  const tau = pts.map((p) => p.t - t0);
  if (tau[tau.length - 1] <= 0) return null;

  const gCorr = tau.map((tt) => 0.5 * GRAVITY * tt * tt);
  const obsW = pts.map((p, i) => [p.x, p.y + gCorr[i], p.z]);

  const degree = pts.length >= QUAD_MIN_N ? 2 : 1;
  const A = tau.map((tt) => (degree === 2 ? [1, tt, tt * tt] : [1, tt]));

  let mask = pts.map(() => true);
  let coef = null;
  const sel = (arr, m) => arr.filter((_, i) => m[i]);

  for (let round = 0; round < MAX_ROUNDS; round++) {
    coef = lstsq(sel(A, mask), sel(obsW, mask));
    const resid = pts.map((_, i) => {
      let dx = 0;
      const fit = [0, 1, 2].map((ax) => A[i].reduce((acc, a, j) => acc + a * coef[j][ax], 0));
      for (let ax = 0; ax < 3; ax++) dx += (obsW[i][ax] - fit[ax]) ** 2;
      return Math.sqrt(dx);
    });
    const inResid = sel(resid, mask);
    const med = median(inResid);
    const mad = median(inResid.map((r) => Math.abs(r - med)));
    const sigma = Math.max(1.4826 * mad, 1e-6);
    const gate = Math.max(OUT_SIGMA * sigma, OUT_FLOOR);
    const newMask = resid.map((r) => r <= gate);
    if (newMask.filter(Boolean).length < MIN_POINTS) break;
    if (newMask.every((v, i) => v === mask[i])) break;
    mask = newMask;
  }
  coef = lstsq(sel(A, mask), sel(obsW, mask));
  return metricsFromV(coef[1][0], coef[1][1], coef[1][2]);
}

function metricsFromV(vx, vy, vz) {
  const horiz = Math.hypot(vx, vz);
  return {
    ev: Math.hypot(vx, vy, vz) * MPH,
    la: (Math.atan2(vy, horiz) * 180) / Math.PI,
    sa: (Math.atan2(vx, vz) * 180) / Math.PI,
  };
}

// ── Monte Carlo comparison ────────────────────────────────────────────────────
const TRIALS = 500;
const scenarios = [
  { ev: 98, la: 27, sa: -8 },
  { ev: 72, la: 12, sa: 20 },
  { ev: 110, la: 35, sa: 0 },
  { ev: 55, la: -5, sa: -30 },
];

let failNew = 0;
for (const sc of scenarios) {
  const truth = simulate(sc.ev, sc.la, sc.sa);
  const errs = { old: { ev: [], la: [], sa: [] }, new: { ev: [], la: [], sa: [] } };
  for (let i = 0; i < TRIALS; i++) {
    const noisy = corrupt(truth);
    const o = fitOld(noisy);
    const n = fitNew(noisy);
    if (!n) { failNew++; continue; }
    if (o) {
      errs.old.ev.push(Math.abs(o.ev - sc.ev));
      errs.old.la.push(Math.abs(o.la - sc.la));
      errs.old.sa.push(Math.abs(o.sa - sc.sa));
    }
    errs.new.ev.push(Math.abs(n.ev - sc.ev));
    errs.new.la.push(Math.abs(n.la - sc.la));
    errs.new.sa.push(Math.abs(n.sa - sc.sa));
  }
  const stat = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return { med: s[s.length >> 1].toFixed(2), p95: s[Math.floor(s.length * 0.95)].toFixed(2) };
  };
  console.log(`\n— Truth EV ${sc.ev} mph, LA ${sc.la}°, SA ${sc.sa}°  (${TRIALS} trials)`);
  for (const m of ['ev', 'la', 'sa']) {
    const so = stat(errs.old[m]), sn = stat(errs.new[m]);
    const unit = m === 'ev' ? 'mph' : '°';
    console.log(
      `  ${m.toUpperCase().padEnd(2)} error  old: med ${so.med} / p95 ${so.p95} ${unit}   ` +
      `new: med ${sn.med} / p95 ${sn.p95} ${unit}`,
    );
  }
}
console.log(`\nfitNew returned null in ${failNew} trials`);

// Sanity: clean, dense, no-outlier input should recover truth almost exactly
seed = 7;
const clean = simulate(98, 27, -8).map((p) => ({ ...p }));
const exact = fitNew(clean);
console.log(`\nClean-input sanity: EV ${exact.ev.toFixed(2)} (98)  LA ${exact.la.toFixed(2)} (27)  SA ${exact.sa.toFixed(2)} (-8)`);
const ok = Math.abs(exact.ev - 98) < 0.5 && Math.abs(exact.la - 27) < 0.5 && Math.abs(exact.sa - -8) < 0.5;
console.log(ok ? 'SANITY PASS' : 'SANITY FAIL');
process.exit(ok ? 0 : 1);
