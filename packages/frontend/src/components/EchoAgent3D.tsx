import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Icosahedron, MeshDistortMaterial } from "@react-three/drei";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import * as THREE from "three";
import type { AssistantState } from "@kodama/shared";

const COLOR: Record<AssistantState, string> = {
  IDLE: "#5fe9ff",
  LISTENING: "#54e6a8",
  THINKING: "#9c7cff",
  SPEAKING: "#bfeaff",
};

interface Cfg {
  distort: number;
  speed: number;
  rot: number;
}
const CFG: Record<AssistantState, Cfg> = {
  IDLE: { distort: 0.22, speed: 1.1, rot: 0.05 },
  LISTENING: { distort: 0.34, speed: 2.0, rot: 0.12 },
  THINKING: { distort: 0.55, speed: 4.0, rot: 0.35 },
  SPEAKING: { distort: 0.48, speed: 3.0, rot: 0.16 },
};

/** 発光する歪んだコア（生きているような存在感） */
function Core({ state, level }: { state: AssistantState; level: number }) {
  const mesh = useRef<THREE.Mesh>(null);
  // drei のマテリアルは ref 型が緩いため any で受ける
  const mat = useRef<any>(null);
  const target = useRef(new THREE.Color(COLOR[state]));
  // マイク音量の平滑値とピクつきの目標位置
  const lvl = useRef(0);
  const twitch = useRef(new THREE.Vector3());

  useFrame((s, dt) => {
    const c = CFG[state];
    target.current.set(COLOR[state]);
    // 音量は約10回/秒で届くので補間して滑らかに追従させる.
    lvl.current = THREE.MathUtils.lerp(lvl.current, level, 0.25);
    const tw = lvl.current;

    if (mesh.current) {
      mesh.current.rotation.y += c.rot * dt;
      mesh.current.rotation.x += c.rot * 0.5 * dt;
      // 音を受けている間は回転にも微小なキックを加える.
      mesh.current.rotation.z += (Math.random() - 0.5) * 0.5 * tw * dt;

      // ピクピク: 散発的に微小な目標位置を決め, そこへ素早く寄せる.
      const amp = 0.18 * tw;
      if (Math.random() < 0.3) {
        twitch.current.set(
          (Math.random() - 0.5) * amp,
          (Math.random() - 0.5) * amp,
          0,
        );
      }
      mesh.current.position.lerp(twitch.current, 0.45);

      const t = s.clock.elapsedTime;
      const base =
        state === "SPEAKING"
          ? 1 + 0.14 * Math.abs(Math.sin(t * 6))
          : 1 + 0.03 * Math.sin(t * 1.5);
      // 音を受けている間はわずかに膨らみ, 反応を強調する.
      mesh.current.scale.setScalar(base + 0.06 * tw);
    }
    if (mat.current) {
      mat.current.distort = THREE.MathUtils.lerp(mat.current.distort, c.distort, 0.05);
      mat.current.speed = c.speed;
      mat.current.color.lerp(target.current, 0.06);
      mat.current.emissive.lerp(target.current, 0.06);
    }
  });

  return (
    <Icosahedron ref={mesh} args={[1.15, 12]}>
      <MeshDistortMaterial
        ref={mat}
        color={COLOR[state]}
        emissive={COLOR[state]}
        emissiveIntensity={0.7}
        roughness={0.15}
        metalness={0.1}
        distort={0.25}
        speed={1.5}
      />
    </Icosahedron>
  );
}

/** コアを取り巻く粒子群（こだまの残響） */
function Halo({ state }: { state: AssistantState }) {
  const pts = useRef<THREE.Points>(null);
  const geom = useMemo(() => {
    const N = 1400;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = 2.1 + Math.random() * 1.7;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
      pos[i * 3 + 2] = r * Math.cos(ph);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return g;
  }, []);

  useFrame((_, dt) => {
    const c = CFG[state];
    if (pts.current) {
      pts.current.rotation.y += c.rot * 0.6 * dt;
      pts.current.rotation.x -= c.rot * 0.3 * dt;
    }
  });

  return (
    <points ref={pts} geometry={geom}>
      <pointsMaterial
        size={0.028}
        color={COLOR[state]}
        transparent
        opacity={0.7}
        sizeAttenuation
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

/** 3DのUIエージェント「こだまの精」. 発光する抽象的な存在. */
export function EchoAgent3D({
  state,
  level = 0,
}: {
  state: AssistantState;
  level?: number;
}) {
  return (
    <Canvas
      className="echo-agent"
      camera={{ position: [0, 0, 6], fov: 45 }}
      dpr={[1, 2]}
    >
      <color attach="background" args={["#080a12"]} />
      <ambientLight intensity={0.45} />
      <pointLight position={[4, 4, 5]} intensity={1.4} />
      <pointLight position={[-5, -3, 2]} intensity={0.6} color="#7c5cff" />
      <Core state={state} level={level} />
      <Halo state={state} />
      <EffectComposer>
        <Bloom
          intensity={1.3}
          luminanceThreshold={0.15}
          luminanceSmoothing={0.5}
          mipmapBlur
        />
      </EffectComposer>
    </Canvas>
  );
}
