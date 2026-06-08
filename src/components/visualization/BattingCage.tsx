/**
 * 3D batting cage built with React Three Fiber.
 * Home plate at origin (+Z toward pitcher).
 * Animated pitch tracking line loops from mound to plate.
 */

import React, { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';

// ─── Constants ────────────────────────────────────────────────────────────────
const CAGE_W  = 4.27;   // 14 ft wide
const CAGE_H  = 3.66;   // 12 ft tall
const CAGE_L  = 20.5;   // length to far pitcher net
const BACK    = 1.8;    // cage depth behind home plate
const HW      = CAGE_W / 2;
const MOUND_Z = 18.44;  // 60 ft 6 in

const SZ_W = 0.432, SZ_H = 0.610, SZ_D = 0.432;
const SZ_CY = 0.762, SZ_CZ = SZ_D / 2;

const PITCH_SECS = 1.4;  // travel time mound → plate
const PAUSE_SECS = 0.9;  // reset pause
const TRAIL_MAX  = 72;   // trail sample count

const NET_SP = 0.28;     // netting grid spacing (m)

// ─── Pitch physics ────────────────────────────────────────────────────────────
function pitchAt(t: number): THREE.Vector3 {
  const z = MOUND_Z * (1 - t);
  const y = 1.85 - (1.85 - 0.82) * t - 0.22 * t * (1 - t);
  return new THREE.Vector3(0, Math.max(0.4, y), z);
}

// ─── Net geometry builders ────────────────────────────────────────────────────
/** YZ-plane net (side walls) */
function makeSideNet(zLen: number, yLen: number): THREE.BufferGeometry {
  const v: number[] = [];
  const nz = Math.ceil(zLen / NET_SP), ny = Math.ceil(yLen / NET_SP);
  for (let i = 0; i <= ny; i++) { const y = (i / ny) * yLen; v.push(0, y, 0, 0, y, zLen); }
  for (let j = 0; j <= nz; j++) { const z = (j / nz) * zLen; v.push(0, 0, z, 0, yLen, z); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  return g;
}

/** XY-plane net (end walls) */
function makeEndNet(xLen: number, yLen: number): THREE.BufferGeometry {
  const v: number[] = [];
  const nx = Math.ceil(xLen / NET_SP), ny = Math.ceil(yLen / NET_SP);
  for (let i = 0; i <= ny; i++) { const y = (i / ny) * yLen; v.push(-xLen / 2, y, 0, xLen / 2, y, 0); }
  for (let j = 0; j <= nx; j++) { const x = -xLen / 2 + (j / nx) * xLen; v.push(x, 0, 0, x, yLen, 0); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  return g;
}

/** XZ-plane net (ceiling) */
function makeCeilingNet(xLen: number, zLen: number): THREE.BufferGeometry {
  const v: number[] = [];
  const nx = Math.ceil(xLen / NET_SP), nz = Math.ceil(zLen / NET_SP);
  for (let i = 0; i <= nx; i++) { const x = -xLen / 2 + (i / nx) * xLen; v.push(x, 0, 0, x, 0, zLen); }
  for (let j = 0; j <= nz; j++) { const z = (j / nz) * zLen; v.push(-xLen / 2, 0, z, xLen / 2, 0, z); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  return g;
}

// ─── Components ───────────────────────────────────────────────────────────────

function CageFrame() {
  const geo = useMemo(() => {
    const B = -BACK, F = CAGE_L;
    const C: [number, number, number][] = [
      [-HW, 0, B], [HW, 0, B], [HW, 0, F], [-HW, 0, F],
      [-HW, CAGE_H, B], [HW, CAGE_H, B], [HW, CAGE_H, F], [-HW, CAGE_H, F],
    ];
    const idx = [0,1, 1,2, 2,3, 3,0, 4,5, 5,6, 6,7, 7,4, 0,4, 1,5, 2,6, 3,7];
    const v: number[] = [];
    for (let i = 0; i < idx.length; i += 2) v.push(...C[idx[i]], ...C[idx[i + 1]]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    return g;
  }, []);

  return (
    <lineSegments geometry={geo}>
      <lineBasicMaterial color="#2e4a5a" />
    </lineSegments>
  );
}

function Netting() {
  const totalLen = CAGE_L + BACK;
  const sideGeo    = useMemo(() => makeSideNet(totalLen, CAGE_H), [totalLen]);
  const endFarGeo  = useMemo(() => makeEndNet(CAGE_W, CAGE_H), []);
  const endBackGeo = useMemo(() => makeEndNet(CAGE_W, CAGE_H), []);
  const ceilGeo    = useMemo(() => makeCeilingNet(CAGE_W, totalLen), [totalLen]);

  const color = '#7aaccc';
  const op    = 0.1;

  return (
    <group>
      <lineSegments geometry={sideGeo} position={[-HW, 0, -BACK]}>
        <lineBasicMaterial color={color} opacity={op} transparent />
      </lineSegments>
      <lineSegments geometry={sideGeo} position={[HW, 0, -BACK]}>
        <lineBasicMaterial color={color} opacity={op} transparent />
      </lineSegments>
      <lineSegments geometry={endFarGeo} position={[0, 0, CAGE_L]}>
        <lineBasicMaterial color={color} opacity={op} transparent />
      </lineSegments>
      <lineSegments geometry={endBackGeo} position={[0, 0, -BACK]}>
        <lineBasicMaterial color={color} opacity={op} transparent />
      </lineSegments>
      <lineSegments geometry={ceilGeo} position={[0, CAGE_H, -BACK]}>
        <lineBasicMaterial color={color} opacity={op} transparent />
      </lineSegments>
    </group>
  );
}

function FloorAndDirt() {
  return (
    <group>
      {/* Grass floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, (CAGE_L - BACK) / 2]}>
        <planeGeometry args={[CAGE_W, CAGE_L + BACK]} />
        <meshLambertMaterial color="#0d2208" />
      </mesh>
      {/* Batter's box dirt */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0.9]}>
        <planeGeometry args={[2.4, 3.4]} />
        <meshLambertMaterial color="#3d2210" />
      </mesh>
    </group>
  );
}

function HomePlate() {
  const geo = useMemo(() => {
    const shape = new THREE.Shape([
      new THREE.Vector2(-0.216, 0),
      new THREE.Vector2(0.216, 0),
      new THREE.Vector2(0.216, 0.216),
      new THREE.Vector2(0, 0.432),
      new THREE.Vector2(-0.216, 0.216),
    ]);
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(Math.PI / 2);
    return g;
  }, []);

  return (
    <mesh geometry={geo} position={[0, 0.005, 0]}>
      <meshStandardMaterial color="#e8e8e8" roughness={0.6} />
    </mesh>
  );
}

function StrikeZone() {
  const boxGeo   = useMemo(() => new THREE.BoxGeometry(SZ_W, SZ_H, SZ_D), []);
  const edgesGeo = useMemo(() => new THREE.EdgesGeometry(boxGeo), [boxGeo]);

  return (
    <group position={[0, SZ_CY, SZ_CZ]}>
      <mesh geometry={boxGeo}>
        <meshBasicMaterial color="#00ff88" opacity={0.04} transparent depthWrite={false} />
      </mesh>
      <lineSegments geometry={edgesGeo}>
        <lineBasicMaterial color="#00ff88" opacity={0.6} transparent />
      </lineSegments>
      {/* Top boundary */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, SZ_H / 2, 0]}>
        <planeGeometry args={[SZ_W, SZ_D]} />
        <meshBasicMaterial color="#00ff88" opacity={0.14} transparent side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      {/* Bottom boundary */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -SZ_H / 2, 0]}>
        <planeGeometry args={[SZ_W, SZ_D]} />
        <meshBasicMaterial color="#00ff88" opacity={0.14} transparent side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
    </group>
  );
}

function PitchersMound() {
  return (
    <group position={[0, 0, MOUND_Z]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[2.74, 32]} />
        <meshLambertMaterial color="#3d2210" />
      </mesh>
      <mesh position={[0, 0.01, 0]}>
        <boxGeometry args={[0.61, 0.04, 0.15]} />
        <meshBasicMaterial color="#e8e8e8" />
      </mesh>
    </group>
  );
}

function CageLights() {
  const lpos: [number, number, number][] = [
    [-HW + 0.3, CAGE_H - 0.1, 4],
    [HW - 0.3,  CAGE_H - 0.1, 4],
    [-HW + 0.3, CAGE_H - 0.1, 10],
    [HW - 0.3,  CAGE_H - 0.1, 10],
    [-HW + 0.3, CAGE_H - 0.1, 16],
    [HW - 0.3,  CAGE_H - 0.1, 16],
  ];
  return (
    <>
      <ambientLight color="#1a2a3a" intensity={1.2} />
      {lpos.map((pos, i) => (
        <group key={i} position={pos}>
          <mesh><boxGeometry args={[0.22, 0.1, 0.4]} /><meshBasicMaterial color="#333" /></mesh>
          <pointLight color="#cce0ff" intensity={9} distance={13} decay={2} />
        </group>
      ))}
    </>
  );
}

// ─── Pitch tracer (animated) ──────────────────────────────────────────────────

function PitchTracer() {
  const ballRef  = useRef<THREE.Group>(null);
  const lightRef = useRef<THREE.PointLight>(null);

  const tRef        = useRef(0);
  const phase       = useRef<'flying' | 'paused'>('flying');
  const pauseTimer  = useRef(0);
  const trailCount  = useRef(0);

  // Pre-allocate trail buffer + Three.js objects so nothing is reallocated per frame
  const trailData = useMemo(() => new Float32Array(TRAIL_MAX * 3), []);

  const { trailLine, trailGeo, trailAttr, pathLine } = useMemo(() => {
    // Trail
    const tGeo  = new THREE.BufferGeometry();
    const tAttr = new THREE.BufferAttribute(trailData, 3);
    tAttr.setUsage(THREE.DynamicDrawUsage);
    tGeo.setAttribute('position', tAttr);
    tGeo.setDrawRange(0, 0);
    const tMat  = new THREE.LineBasicMaterial({ color: '#00ff88', opacity: 0.9, transparent: true });
    const tLine = new THREE.Line(tGeo, tMat);

    // Ghost pitch-path preview
    const pPts: THREE.Vector3[] = [];
    for (let i = 0; i <= 80; i++) pPts.push(pitchAt(i / 80));
    const pGeo  = new THREE.BufferGeometry().setFromPoints(pPts);
    const pMat  = new THREE.LineBasicMaterial({ color: '#00ff44', opacity: 0.07, transparent: true });
    const pLine = new THREE.Line(pGeo, pMat);

    return { trailLine: tLine, trailGeo: tGeo, trailAttr: tAttr, pathLine: pLine };
  }, [trailData]);

  useFrame((_, delta) => {
    if (phase.current === 'paused') {
      pauseTimer.current += delta;
      if (pauseTimer.current >= PAUSE_SECS) {
        phase.current   = 'flying';
        tRef.current    = 0;
        pauseTimer.current = 0;
        trailCount.current = 0;
        trailGeo.setDrawRange(0, 0);
        if (ballRef.current) ballRef.current.visible = true;
      }
      return;
    }

    tRef.current = Math.min(tRef.current + delta / PITCH_SECS, 1);
    const pos = pitchAt(tRef.current);

    if (ballRef.current)  ballRef.current.position.copy(pos);
    if (lightRef.current) lightRef.current.position.copy(pos);

    // Trail buffer update (in-place, no allocation)
    if (trailCount.current >= TRAIL_MAX) {
      trailData.copyWithin(0, 3);
      trailCount.current = TRAIL_MAX - 1;
    }
    const i = trailCount.current * 3;
    trailData[i] = pos.x; trailData[i + 1] = pos.y; trailData[i + 2] = pos.z;
    trailCount.current++;
    trailAttr.needsUpdate = true;
    trailGeo.setDrawRange(0, trailCount.current);

    if (tRef.current >= 1) {
      phase.current = 'paused';
      if (ballRef.current) ballRef.current.visible = false;
    }
  });

  return (
    <group>
      {/* Ghost path */}
      <primitive object={pathLine} />
      {/* Live trail */}
      <primitive object={trailLine} />

      {/* Ball + layered glow halos */}
      <group ref={ballRef}>
        <mesh>
          <sphereGeometry args={[0.037, 16, 16]} />
          <meshStandardMaterial
            color="#00ff44"
            emissive="#00ff44"
            emissiveIntensity={3.5}
            roughness={0.15}
          />
        </mesh>
        <mesh>
          <sphereGeometry args={[0.058, 8, 8]} />
          <meshBasicMaterial color="#66ffaa" opacity={0.3} transparent depthWrite={false} />
        </mesh>
        <mesh>
          <sphereGeometry args={[0.095, 8, 8]} />
          <meshBasicMaterial color="#00ff44" opacity={0.12} transparent depthWrite={false} />
        </mesh>
      </group>

      {/* Dynamic green point light follows the ball */}
      <pointLight ref={lightRef} color="#00ff44" intensity={7} distance={8} decay={2} />
    </group>
  );
}

// ─── Scene ────────────────────────────────────────────────────────────────────

function Scene() {
  return (
    <>
      <color attach="background" args={['#04060e']} />
      <fog attach="fog" args={['#04060e', 20, 36]} />

      <PerspectiveCamera makeDefault position={[5.5, 2.4, -3.5]} fov={52} near={0.1} far={80} />
      <OrbitControls
        target={[0, 1.2, 10]}
        minDistance={2}
        maxDistance={40}
        maxPolarAngle={Math.PI * 0.85}
      />

      <CageLights />
      <CageFrame />
      <Netting />
      <FloorAndDirt />
      <HomePlate />
      <StrikeZone />
      <PitchersMound />
      <PitchTracer />
    </>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

export function BattingCage(): React.ReactElement {
  return (
    <div style={styles.root}>
      <Canvas gl={{ antialias: true, alpha: false }} style={{ width: '100%', height: '100%' }}>
        <Scene />
      </Canvas>

      <div style={styles.hud}>
        <div style={styles.hudTitle}>
          <span style={styles.dot} />
          PITCH TRACKER
        </div>
        <Stat label="ZONE"  value="17 × 17 in" />
        <Stat label="MOUND" value="60.5 ft" />
        <Stat label="HT"    value="1.85 → 0.82 m" />
      </div>

      <div style={styles.hint}>drag · scroll</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.stat}>
      <span style={styles.statKey}>{label}</span>
      <span style={styles.statVal}>{value}</span>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const ff = "'JetBrains Mono', 'Fira Code', monospace";

const styles: Record<string, React.CSSProperties> = {
  root: { position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: '#04060e' },
  hud: {
    position: 'absolute', top: 14, left: 14,
    background: 'rgba(4,6,14,0.88)', border: '1px solid #0d2a0d',
    borderRadius: 7, padding: '10px 14px',
    display: 'flex', flexDirection: 'column', gap: 5,
    pointerEvents: 'none', fontFamily: ff,
  },
  hudTitle: {
    display: 'flex', alignItems: 'center', gap: 7,
    fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', color: '#00ff44',
    marginBottom: 4,
  },
  dot: {
    width: 6, height: 6, borderRadius: '50%',
    background: '#00ff44', boxShadow: '0 0 6px #00ff44',
    display: 'inline-block',
  },
  stat: { display: 'flex', gap: 10, alignItems: 'baseline' },
  statKey: { fontSize: 8, color: '#335533', letterSpacing: '0.12em', width: 40, fontFamily: ff },
  statVal: { fontSize: 11, color: '#88cc88', fontWeight: 600, fontVariantNumeric: 'tabular-nums', fontFamily: ff },
  hint: {
    position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
    fontSize: 9, color: '#1a2a1a', letterSpacing: '0.12em', pointerEvents: 'none', fontFamily: ff,
  },
};
