import { useEffect, useRef } from "react";
import type { AssistantState } from "@kodama/shared";

interface Palette {
  core: string;
  ring: string;
  glow: string;
}
const PALETTE: Record<AssistantState, Palette> = {
  IDLE: { core: "#9be8ff", ring: "#3fd0e6", glow: "rgba(58,166,200,0.5)" },
  LISTENING: { core: "#aef0c8", ring: "#54e6a8", glow: "rgba(54,201,142,0.6)" },
  THINKING: { core: "#c9b8ff", ring: "#9c7cff", glow: "rgba(109,79,208,0.6)" },
  SPEAKING: { core: "#eafcff", ring: "#5fe9ff", glow: "rgba(58,140,255,0.7)" },
};

interface Ripple {
  r: number;
  speed: number;
  alpha: number;
}
interface Particle {
  angle: number;
  radius: number;
  speed: number;
  size: number;
}

/**
 * 2DのUIエージェント「こだまの精」.
 * 状態(IDLE/LISTENING/THINKING/SPEAKING)に応じて, 呼吸・波紋・粒子の渦・
 * 発話パルスでリアルタイムに反応する. Canvas 2D + rAF で滑らかに描画.
 * level(0-1) は将来の実音声振幅. 現状は擬似的に揺らす.
 */
export function EchoAgent({
  state,
  level = 0,
}: {
  state: AssistantState;
  level?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  const levelRef = useRef(level);
  stateRef.current = state;
  levelRef.current = level;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    let t = 0;
    let lastEmit = 0;

    const ripples: Ripple[] = [];
    const particles: Particle[] = Array.from({ length: 28 }, () => ({
      angle: Math.random() * Math.PI * 2,
      radius: 60 + Math.random() * 70,
      speed: 0.002 + Math.random() * 0.004,
      size: 1 + Math.random() * 2,
    }));

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const size = Math.min(canvas.clientWidth, canvas.clientHeight);
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const cx = w / 2;
      const cy = h / 2;
      const st = stateRef.current;
      const pal = PALETTE[st];
      t += 1;

      // 残像で発光感を出す
      ctx.fillStyle = "rgba(8,10,18,0.28)";
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";

      // 擬似振幅（SPEAKINGは大きく脈動）
      const amp =
        levelRef.current > 0
          ? levelRef.current
          : st === "SPEAKING"
            ? 0.5 + 0.5 * Math.abs(Math.sin(t * 0.12))
            : st === "THINKING"
              ? 0.3 + 0.15 * Math.sin(t * 0.05)
              : 0.15;

      const breathe = 1 + 0.06 * Math.sin(t * 0.03);
      const coreR = (26 + amp * 18) * breathe;

      // 波紋の放出レート（状態で変化）
      const emitEvery =
        st === "SPEAKING" ? 22 : st === "LISTENING" ? 40 : st === "THINKING" ? 55 : 90;
      if (t - lastEmit > emitEvery) {
        lastEmit = t;
        ripples.push({
          r: coreR,
          speed: st === "LISTENING" ? -0.9 : 0.9 + amp * 1.4,
          alpha: 0.5,
        });
      }

      // 波紋（LISTENINGは内向きに収束）
      ctx.lineWidth = 2;
      for (let i = ripples.length - 1; i >= 0; i--) {
        const rp = ripples[i]!;
        rp.r += rp.speed;
        rp.alpha -= 0.006;
        if (rp.alpha <= 0 || rp.r < 4 || rp.r > Math.max(w, h)) {
          ripples.splice(i, 1);
          continue;
        }
        ctx.beginPath();
        ctx.strokeStyle = pal.ring;
        ctx.globalAlpha = Math.max(0, rp.alpha);
        ctx.arc(cx, cy, rp.r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // 粒子の渦（THINKINGで加速・収束）
      const swirl = st === "THINKING" ? 3.2 : st === "LISTENING" ? 1.6 : 1;
      const pull = st === "THINKING" ? 0.97 : st === "LISTENING" ? 0.99 : 1.001;
      for (const p of particles) {
        p.angle += p.speed * swirl;
        p.radius *= pull;
        if (p.radius < 40) p.radius = 120 + Math.random() * 30;
        const px = cx + Math.cos(p.angle) * p.radius;
        const py = cy + Math.sin(p.angle) * p.radius;
        ctx.beginPath();
        ctx.fillStyle = pal.core;
        ctx.globalAlpha = 0.5;
        ctx.arc(px, py, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // 中心オーブ
      const grad = ctx.createRadialGradient(cx, cy - coreR * 0.2, 2, cx, cy, coreR);
      grad.addColorStop(0, "#ffffff");
      grad.addColorStop(0.4, pal.core);
      grad.addColorStop(1, pal.glow);
      ctx.beginPath();
      ctx.fillStyle = grad;
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalCompositeOperation = "source-over";
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="echo-agent" aria-label="こだまの精" />;
}
