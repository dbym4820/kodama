import { useCallback, useEffect, useRef, useState } from "react";
import {
  AssistantState,
  type ClientCommand,
  type ServerEvent,
} from "@kodama/shared";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
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
  send: (cmd: ClientCommand) => void;
}

/**
 * バックエンドの /ws に接続し, 状態機械・文字起こし・応答デルタを購読する.
 * バックエンド未起動時はローカルで状態を巡回させるデモモードに自動でフォールバックし,
 * ロゴとUIエージェントの反応を確認できるようにする.
 */
export function useKodamaSocket(): KodamaState {
  const [s, setS] = useState<Omit<KodamaState, "send">>({
    connected: false,
    state: AssistantState.IDLE,
    present: false,
    messages: [],
    assistant: "",
    level: 0,
    status: "",
    stt: "",
    interim: "",
  });
  const demoTimer = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const idRef = useRef(0);
  const nextId = () => `m${++idRef.current}`;

  const send = useCallback((cmd: ClientCommand) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(cmd));
  }, []);

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
                  { id: nextId(), role: "user", text: ev.text },
                ],
              };
            case "audio":
              return { ...p, level: ev.level };
            case "stt":
              return { ...p, stt: ev.text };
            case "status":
              return { ...p, status: ev.text };
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

  return { ...s, send };
}
