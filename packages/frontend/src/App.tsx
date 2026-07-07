import { useEffect, useRef, useState } from "react";
import { DEFAULT_SHORTCUTS, type ShortcutSettings } from "@kodama/shared";
import { useKodamaSocket } from "./useKodamaSocket.js";
import { matchAccelerator } from "./shortcuts.js";
import { KodamaLogo } from "./components/KodamaLogo.js";
import { EchoAgent3D } from "./components/EchoAgent3D.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { FilesPanel } from "./components/FilesPanel.js";
import { UploadDropzone } from "./components/UploadDropzone.js";
import { DownloadStack } from "./components/DownloadStack.js";
import { Markdown } from "./components/Markdown.js";
import { GenerativePanel } from "./components/GenerativePanel.js";

const STATE_LABEL: Record<string, string> = {
  IDLE: "待機",
  LISTENING: "傾聴",
  THINKING: "思考",
  SPEAKING: "発話",
};

export function App() {
  const {
    connected,
    state,
    present,
    messages,
    assistant,
    level,
    status,
    stt,
    interim,
    ui,
    upload,
    downloads,
    clearUi,
    clearUpload,
    clearDownload,
    shortcuts: liveShortcuts,
    send,
  } = useKodamaSocket();
  const [text, setText] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  /** 拡大表示中の応答本文（nullなら非表示） */
  const [zoom, setZoom] = useState<string | null>(null);
  /** グローバルショートカット設定（初期はRESTで取得, 変更はWSで追随） */
  const [shortcuts, setShortcuts] = useState<ShortcutSettings>(DEFAULT_SHORTCUTS);
  const logRef = useRef<HTMLDivElement | null>(null);

  // 新しい発話が来たらログを最下部へスクロールする.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, assistant, interim]);

  // ショートカット設定を取得し, 設定画面での変更（WS配信）へ即時追随する.
  useEffect(() => {
    fetch("/api/shortcuts")
      .then((r) => r.json())
      .then((s: ShortcutSettings) => setShortcuts(s))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (liveShortcuts) setShortcuts(liveShortcuts);
  }, [liveShortcuts]);

  // Electronのグローバルショートカット（Cmd+,）からの設定画面オープン要求.
  useEffect(() => {
    const toggle = () => setSettingsOpen((v) => !v);
    window.addEventListener("kodama:open-settings", toggle);
    return () => window.removeEventListener("kodama:open-settings", toggle);
  }, []);

  // ブラウザ単体で開いた場合のキーバインド（Electron内ではglobalShortcutが担うため無効化,
  // 二重発火を防ぐ）. 設定画面の開閉とヒアリングモード（発話中はカットイン）.
  useEffect(() => {
    if (navigator.userAgent.includes("Electron")) return;
    const onKey = (e: KeyboardEvent) => {
      if (matchAccelerator(shortcuts.openSettings, e)) {
        e.preventDefault();
        setSettingsOpen((v) => !v);
      } else if (matchAccelerator(shortcuts.hearing, e)) {
        e.preventDefault();
        send({ type: "wake" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcuts, send]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    send({ type: "text_input", text: t });
    setText("");
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <KodamaLogo state={state} size={38} />
          <div className="brand-text">
            <span className="brand-kanji">谺</span>
            <span className="brand-roman">kodama</span>
          </div>
        </div>
        <div className="topbar-status">
          <div className={`presence ${present ? "in" : "out"}`}>
            <span className="presence-dot" />
            {present ? "在室" : "不在"}
          </div>
          <div className={`conn ${connected ? "on" : "off"}`}>
            {connected ? "接続済み" : "デモ（バックエンド未接続）"}
          </div>
          <button
            type="button"
            className="settings-btn"
            onClick={() => setFilesOpen(true)}
            title="ファイル（アップロード・ダウンロード）"
            aria-label="ファイル"
          >
            📎
          </button>
          <button
            type="button"
            className="settings-btn"
            onClick={() => setSettingsOpen(true)}
            title="設定（音声デバイス）"
            aria-label="設定"
          >
            ⚙
          </button>
        </div>
      </header>

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      {filesOpen && <FilesPanel onClose={() => setFilesOpen(false)} />}
      {zoom && (
        <div className="md-modal-overlay" onClick={() => setZoom(null)}>
          <div className="md-modal" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="md-modal-close"
              onClick={() => setZoom(null)}
              title="閉じる"
            >
              ✕
            </button>
            <Markdown text={zoom} />
          </div>
        </div>
      )}

      <main className="stage">
        <EchoAgent3D state={state} level={level} />
        <div className={`state-pill ${state.toLowerCase()}`}>
          {STATE_LABEL[state] ?? state}
        </div>
        {status && <div className="status-line">{status}</div>}
        <GenerativePanel panels={ui} onClose={clearUi} />
        <DownloadStack offers={downloads} onClose={clearDownload} />
        {upload && (
          <UploadDropzone req={upload} send={send} onClose={clearUpload} />
        )}
        {(state === "THINKING" || state === "SPEAKING") && (
          <button
            type="button"
            className="stop-btn"
            onClick={() => send({ type: "interrupt" })}
            title="谺の発話を止める（「ストップ」と声で言っても止まります）"
          >
            ■ 停止
          </button>
        )}
      </main>

      <footer className="dock">
        <div className="live-caption" title="ローカルWhisperによる常時文字起こし">
          <span className="live-dot" />
          <span className="live-text">{stt || "（聞き取り待機中…）"}</span>
        </div>
        <div className="transcript" ref={logRef}>
          {messages.length === 0 && !assistant && (
            <p className="hint">「こだま」と呼びかけるか，下から入力してください．</p>
          )}
          {messages.map((m) =>
            m.role === "user" ? (
              <p key={m.id} className="user-line">
                {m.speaker ?? "あなた"}: {m.text}
              </p>
            ) : (
              <div key={m.id} className="kodama-line md-line">
                <div className="line-head">
                  <span className="line-label">谺</span>
                  <button
                    type="button"
                    className="zoom-btn"
                    onClick={() => setZoom(m.text)}
                    title="別画面で大きく表示"
                  >
                    ⤢
                  </button>
                </div>
                <Markdown text={m.text} />
              </div>
            ),
          )}
          {interim && (
            <p className="user-line interim">あなた: {interim}</p>
          )}
          {assistant && (
            <div className="kodama-line md-line">
              <div className="line-head">
                <span className="line-label">谺</span>
              </div>
              <Markdown text={assistant} />
            </div>
          )}
        </div>
        <form className="composer" onSubmit={submit}>
          <button
            type="button"
            className="wake-btn"
            onClick={() => send({ type: "wake" })}
            disabled={!connected}
            title="手動ウェイク（「こだま」と呼ぶのと同じ）"
          >
            谺
          </button>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="谺に話しかける（テキスト）…"
          />
          <button type="submit" disabled={!connected || !text.trim()}>
            送信
          </button>
        </form>
      </footer>
    </div>
  );
}
