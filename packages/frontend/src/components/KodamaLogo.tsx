import type { AssistantState } from "@kodama/shared";

const TINT: Record<AssistantState, string> = {
  IDLE: "#5fe9ff",
  LISTENING: "#54e6a8",
  THINKING: "#9c7cff",
  SPEAKING: "#7cc4ff",
};

/** ヘッダの谺ロゴ. 状態に応じて色味と波紋の速さが変わるインラインSVG. */
export function KodamaLogo({
  state,
  size = 40,
}: {
  state: AssistantState;
  size?: number;
}) {
  const tint = TINT[state];
  const dur = state === "SPEAKING" ? "1.8s" : state === "IDLE" ? "3.4s" : "2.4s";
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" aria-label="谺">
      <defs>
        <radialGradient id="logoOrb" cx="50%" cy="42%" r="60%">
          <stop offset="0%" stopColor="#eafcff" />
          <stop offset="40%" stopColor={tint} />
          <stop offset="100%" stopColor="#7c5cff" />
        </radialGradient>
      </defs>
      <g
        transform="translate(128 128)"
        fill="none"
        stroke={tint}
        strokeWidth="4"
      >
        {[0, 1, 2].map((i) => (
          <circle key={i} r="22" opacity="0.9">
            <animate
              attributeName="r"
              values="22;104"
              dur={dur}
              begin={`${(i * Number.parseFloat(dur)) / 3}s`}
              repeatCount="indefinite"
            />
            <animate
              attributeName="opacity"
              values="0.9;0"
              dur={dur}
              begin={`${(i * Number.parseFloat(dur)) / 3}s`}
              repeatCount="indefinite"
            />
          </circle>
        ))}
        <circle r="58" opacity="0.16" />
      </g>
      <circle cx="128" cy="128" r="17" fill="url(#logoOrb)" />
    </svg>
  );
}
