import { z } from "zod";

/** 秘書の対話状態 */
export const AssistantState = {
  IDLE: "IDLE",
  LISTENING: "LISTENING",
  THINKING: "THINKING",
  SPEAKING: "SPEAKING",
} as const;
export type AssistantState =
  (typeof AssistantState)[keyof typeof AssistantState];

/** 発話主体 */
export const Role = z.enum(["user", "assistant", "system"]);
export type Role = z.infer<typeof Role>;

/** 1メッセージの永続レコード */
export const MessageRecord = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: Role,
  text: z.string(),
  /** ローカルディスク上の音声ファイルパス（あれば） */
  audioPath: z.string().nullable(),
  createdAt: z.string(),
});
export type MessageRecord = z.infer<typeof MessageRecord>;

/** 会話セッション */
export const SessionRecord = z.object({
  id: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  summary: z.string().nullable(),
});
export type SessionRecord = z.infer<typeof SessionRecord>;

/** 長期メモ */
export const MemoryRecord = z.object({
  id: z.string(),
  kind: z.string(),
  content: z.string(),
  createdAt: z.string(),
});
export type MemoryRecord = z.infer<typeof MemoryRecord>;

/**
 * バックエンド → Web UI へWebSocketで配信するイベント.
 * 状態機械の遷移や文字起こし・応答デルタをリアルタイム可視化する.
 */
export type ServerEvent =
  | { type: "state"; state: AssistantState }
  | { type: "presence"; present: boolean }
  | { type: "transcript"; final: boolean; text: string }
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_done"; messageId: string }
  /** マイクが拾っている音量レベル（0〜1）．UIエージェントの反応に用いる */
  | { type: "audio"; level: number }
  /** ローカルWhisperによる常時文字起こし（ライブ字幕） */
  | { type: "stt"; text: string }
  /** 思考中の作業内容（ツール実行など）．空文字でクリア */
  | { type: "status"; text: string }
  | { type: "error"; message: string };

/** Web UI → バックエンド へのコマンド */
export type ClientCommand =
  | { type: "text_input"; text: string }
  | { type: "interrupt" }
  | { type: "wake" }
  | { type: "set_persona"; persona: Partial<PersonaConfig> };

/** 音声入出力デバイス（設定画面で切り替え・テスト） */
export interface AudioDevice {
  /** ffmpeg/CoreAudio のデバイスインデックス */
  index: number;
  /** 表示名 */
  name: string;
}

/** 現在の入出力デバイス一覧と選択状態 */
export interface AudioDevicesInfo {
  /** 入力（マイク, avfoundation）デバイス */
  input: AudioDevice[];
  /** 出力（スピーカー, CoreAudio/audiotoolbox）デバイス */
  output: AudioDevice[];
  /** 選択中のインデックス（-1=システム既定） */
  selected: { inputIndex: number; outputIndex: number };
}

/** 入力デバイスのテスト結果（短時間の録音で拾えた音量） */
export interface AudioInputTest {
  /** 観測したピーク音量（0〜1） */
  level: number;
  /** 有意な入力を検知したか */
  ok: boolean;
}

/** 人格・声の調整可能パラメータ（Web UIから変更） */
export interface PersonaConfig {
  /** アシスタントの名前（例: 谺） */
  name: string;
  /** 名前の読み（音声合成・呼びかけ用, 例: こだま） */
  nameReading?: string;
  /** 主人（オーナー）の名前（例: 油谷知岐） */
  owner: string;
  /** 主人の名前の読み（例: あぶらたに ともき） */
  ownerReading?: string;
  /** 主人の呼び方（例: 油谷さん） */
  ownerHonorific?: string;
  /** 追加の人格・口調などの自由記述指示（任意．基本動作の後に付加される） */
  instructions: string;
  /** OpenAI TTS の話者 */
  voice: string;
  /** OpenAI TTS の口調指示 */
  voiceInstructions: string;
}
