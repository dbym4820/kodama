import type { UiPanel } from "../useKodamaSocket.js";

/**
 * Claudeが生成したUI（HTML/CSS）をサンドボックスiframeへ描画するパネル（§15.4）.
 *
 * srcdoc にHTML/CSSを内包し, sandbox属性で隔離する. interactive=true のときだけ
 * スクリプトを許可する（allow-same-origin は付けない＝null originなので, 親のCookieや
 * DOMには触れられない）. 生成UI内からは window.parent.postMessage({kodama:true, name, value})
 * で値を返せ, それが谺への入力として会話に流れる.
 */
function srcDoc(panel: UiPanel): string {
  const base = `
    :root { color-scheme: dark; }
    html,body { margin:0; padding:0; }
    body {
      font-family: system-ui, -apple-system, "Hiragino Sans", sans-serif;
      color:#e8edf5; background:transparent; padding:14px;
      font-size:14px; line-height:1.6;
    }
    a { color:#7fd3ff; }
    table { border-collapse:collapse; width:100%; }
    th,td { border:1px solid #2c3442; padding:6px 8px; text-align:left; }
    th { background:#1a2330; }
    button {
      font:inherit; color:#0b0d12; background:#7fd3ff; border:0;
      border-radius:8px; padding:8px 14px; cursor:pointer; margin:4px 4px 0 0;
    }
    input,select,textarea {
      font:inherit; color:#e8edf5; background:#10151d;
      border:1px solid #2c3442; border-radius:8px; padding:7px 9px; margin:3px 0;
    }
  `;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${base}\n${panel.css ?? ""}</style></head><body>${panel.html}</body></html>`;
}

export function GenerativePanel({
  panels,
  onClose,
}: {
  panels: UiPanel[];
  onClose: (id: string) => void;
}) {
  if (!panels.length) return null;
  return (
    <div className="gen-ui">
      {panels.map((p) => (
        <div className="gen-ui-card" key={p.id}>
          <div className="gen-ui-bar">
            <span className="gen-ui-title">{p.title || "谺の画面"}</span>
            <button
              type="button"
              className="gen-ui-close"
              onClick={() => onClose(p.id)}
              aria-label="閉じる"
              title="閉じる"
            >
              ×
            </button>
          </div>
          <iframe
            className="gen-ui-frame"
            title={p.title || "谺の画面"}
            sandbox={p.interactive ? "allow-scripts" : ""}
            srcDoc={srcDoc(p)}
          />
        </div>
      ))}
    </div>
  );
}
