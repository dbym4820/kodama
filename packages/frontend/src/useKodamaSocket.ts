import { useCallback, useEffect, useRef, useState } from "react";
import {
  AssistantState,
  type ClientCommand,
  type FileRecord,
  type ServerEvent,
  type ShortcutSettings,
} from "@kodama/shared";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** 話者識別の結果（登録名または「ゲストA」等．無ければ未識別） */
  speaker?: string;
}

/** Claudeが生成したUIパネル（サンドボックスiframeへ描画, §15.4） */
export interface UiPanel {
  id: string;
  html: string;
  css?: string;
  title?: string;
  interactive?: boolean;
}

/** 谺からのファイルアップロード要求（一時表示するドロップゾーンの内容） */
export interface UploadRequest {
  id: string;
  title?: string;
  accept?: string;
  multiple?: boolean;
}

/** ダウンロード提示（save_file / offer_file_download で表示するカード） */
export interface DownloadOffer {
  id: string;
  title?: string;
  files: FileRecord[];
}

export interface KodamaState {
  connected: boolean;
  state: AssistantState;
  present: boolean;
  /** 確定した会話ログ（ユーザー発話・谺の応答） */
  messages: ChatMessage[];
  /** 進行中の谺の応答（ストリーミング表示用） */
  assistant: string;
  /** マイクが拾っている音量レベル（0〜1） */
  level: number;
  /** 思考中の作業内容（ツール実行など）．空なら非表示 */
  status: string;
  /** ローカルWhisperの常時文字起こし（ライブ字幕） */
  stt: string;
  /** ストリーミングSTTの確定前の部分文字起こし（傾聴中にリアルタイム表示） */
  interim: string;
  /** Claudeが生成した表示中のUIパネル（§15.4） */
  ui: UiPanel[];
  /** 表示中のファイルアップロード要求（ドロップゾーン）．null なら非表示 */
  upload: UploadRequest | null;
  /** 表示中のダウンロードカード */
  downloads: DownloadOffer[];
  /** グローバルショートカット設定（変更が配信されたら更新．未受信は null） */
  shortcuts: ShortcutSettings | null;
  /** 生成UIパネルを閉じる（id省略で全消去） */
  clearUi: (id?: string) => void;
  /** アップロード要求（ドロップゾーン）を閉じる */
  clearUpload: () => void;
  /** ダウンロードカードを閉じる */
  clearDownload: (id: string) => void;
  send: (cmd: ClientCommand) => void;
}

/**
 * バックエンドの /ws に接続し, 状態機械・文字起こし・応答デルタを購読する.
 * バックエンド未起動時はローカルで状態を巡回させるデモモードに自動でフォールバックし,
 * ロゴとUIエージェントの反応を確認できるようにする.
 */
export function useKodamaSocket(): KodamaState {
  const [s, setS] = useState<
    Omit<KodamaState, "send" | "clearUi" | "clearUpload" | "clearDownload">
  >({
    connected: false,
    state: AssistantState.IDLE,
    present: false,
    messages: [],
    assistant: "",
    level: 0,
    status: "",
    stt: "",
    interim: "",
    ui: [],
    upload: null,
    downloads: [],
    shortcuts: null,
  });
  const demoTimer = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const idRef = useRef(0);
  const nextId = () => `m${++idRef.current}`;

  const send = useCallback((cmd: ClientCommand) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(cmd));
  }, []);

  const clearUi = useCallback((id?: string) => {
    setS((p) => ({
      ...p,
      ui: id ? p.ui.filter((u) => u.id !== id) : [],
    }));
  }, []);

  const clearUpload = useCallback(() => {
    setS((p) => ({ ...p, upload: null }));
  }, []);

  const clearDownload = useCallback((id: string) => {
    setS((p) => ({ ...p, downloads: p.downloads.filter((d) => d.id !== id) }));
  }, []);

  // 生成UI(iframe)内のフォーム等からの postMessage を谺への入力として転送する（§15.4）.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { kodama?: boolean; name?: string; value?: unknown };
      if (!d || d.kodama !== true) return;
      send({
        type: "ui_event",
        name: String(d.name ?? ""),
        value: String(d.value ?? ""),
      });
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [send]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;

    const startDemo = () => {
      if (demoTimer.current != null) return;
      const cycle: AssistantState[] = [
        AssistantState.IDLE,
        AssistantState.LISTENING,
        AssistantState.THINKING,
        AssistantState.SPEAKING,
      ];
      let i = 0;
      demoTimer.current = window.setInterval(() => {
        i = (i + 1) % cycle.length;
        setS((p) => ({ ...p, state: cycle[i]! }));
      }, 2600);
    };
    const stopDemo = () => {
      if (demoTimer.current != null) {
        clearInterval(demoTimer.current);
        demoTimer.current = null;
      }
    };

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        stopDemo();
        setS((p) => ({ ...p, connected: true }));
      };
      ws.onmessage = (e) => {
        const ev = JSON.parse(e.data as string) as ServerEvent;
        // 副作用を伴うイベントは更新関数の外で処理する（StrictModeの二重実行対策）.
        if (ev.type === "ui_open_url") {
          window.open(ev.url, "_blank", "noopener");
          return;
        }
        if (ev.type === "ui_render" && ev.ttlMs && ev.ttlMs > 0) {
          window.setTimeout(() => clearUi(ev.id), ev.ttlMs);
        }
        setS((p) => {
          switch (ev.type) {
            case "state":
              return { ...p, state: ev.state };
            case "presence":
              return { ...p, present: ev.present };
            case "transcript":
              if (!ev.final) {
                // 確定前の部分文字起こしをライブ表示（薄く表示し, 確定で消す）.
                return { ...p, interim: ev.text };
              }
              // 確定した発話を会話ログへ移し, 部分表示をクリアする.
              if (!ev.text.trim()) return { ...p, interim: "" };
              return {
                ...p,
                interim: "",
                messages: [
                  ...p.messages,
                  { id: nextId(), role: "user", text: ev.text, speaker: ev.speaker },
                ],
              };
            case "audio":
              return { ...p, level: ev.level };
            case "stt":
              return { ...p, stt: ev.text };
            case "status":
              return { ...p, status: ev.text };
            case "shortcuts":
              return { ...p, shortcuts: ev.shortcuts };
            case "ui_render": {
              const panel = {
                id: ev.id,
                html: ev.html,
                css: ev.css,
                title: ev.title,
                interactive: ev.interactive,
              };
              // 同一idは置き換え, それ以外は積み増す（最新を末尾に）. TTL消去は更新関数の外で予約済み.
              return {
                ...p,
                ui: [...p.ui.filter((u) => u.id !== ev.id), panel],
              };
            }
            case "ui_clear":
              return {
                ...p,
                ui: ev.id ? p.ui.filter((u) => u.id !== ev.id) : [],
              };
            case "ui_upload":
              // ドロップゾーンは同時に1つ（新しい要求で置き換える）.
              return {
                ...p,
                upload: {
                  id: ev.id,
                  title: ev.title,
                  accept: ev.accept,
                  multiple: ev.multiple,
                },
              };
            case "ui_download":
              // ダウンロードカードは積み増す（同一idは置き換え, 最新を先頭に）.
              return {
                ...p,
                downloads: [
                  { id: ev.id, title: ev.title, files: ev.files },
                  ...p.downloads.filter((d) => d.id !== ev.id),
                ].slice(0, 5),
              };
            case "assistant_delta":
              return { ...p, assistant: p.assistant + ev.text };
            case "assistant_done": {
              // 進行中の応答を確定ログへ移す.
              const text = p.assistant.trim();
              if (!text) return { ...p, assistant: "" };
              return {
                ...p,
                assistant: "",
                messages: [
                  ...p.messages,
                  { id: nextId(), role: "assistant", text },
                ],
              };
            }
            default:
              return p;
          }
        });
      };
      ws.onclose = () => {
        setS((p) => ({ ...p, connected: false }));
        startDemo();
        if (!closed) setTimeout(connect, 3000);
      };
      ws.onerror = () => ws?.close();
    };

    connect();
    return () => {
      closed = true;
      stopDemo();
      ws?.close();
    };
  }, []);

  return { ...s, send, clearUi, clearUpload, clearDownload };
}
