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
  /** 話者識別の結果（登録名または「ゲストA」等の仮ラベル．識別不能・テキスト入力は null） */
  speaker: z.string().nullable(),
  createdAt: z.string(),
});
export type MessageRecord = z.infer<typeof MessageRecord>;

/**
 * 登録済み話者（声で個人識別する相手）. 声の埋め込みベクトルをDBに蓄え,
 * 発話ごとのコサイン類似度で本人を照合する. 実体の埋め込みはDB側に持ち,
 * ここでは参照用メタデータのみ扱う.
 */
export interface SpeakerRecord {
  id: string;
  /** 名前（表示・照合キー） */
  name: string;
  /** 読み（あれば） */
  reading: string | null;
  /** 蓄えている声サンプル（埋め込み）の数 */
  sampleCount: number;
  createdAt: string;
  updatedAt: string;
}

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
 * 語彙（認識バイアス用）. 固有名詞・専門語・プロジェクト名などを蓄え,
 * STT(whisper)のpromptへ動的に差し込んで認識精度を底上げする（§15.1）.
 * 読み(reading)があれば発音辞書(TTS)へも反映する.
 */
export interface TermRecord {
  id: string;
  /** 表記（whisperヒント／検索キー） */
  surface: string;
  /** 読み（あれば発音辞書へも反映） */
  reading: string | null;
  /** 異表記・誤認識されやすい綴り */
  aliases: string[];
  /** 種別: person | project | jargon | place | other */
  kind: string;
  /** ヒント優先度（出現頻度×新しさで増減） */
  weight: number;
  /** user（明示）| auto（自動抽出） */
  source: string;
  /** 認識ヒットの累積回数（自動語の昇格判定に使う） */
  hitCount: number;
  /** 有効（STTヒントに載せる）か */
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * トピック（話題のまとまり）. 会話を定期的に解析し, 同じ内容のかたまりを
 * 要約して畳み込んだもの（§15.2）. 横断検索(§15.3)の主要な想起源になる.
 */
export interface TopicRecord {
  id: string;
  /** 話題の見出し */
  title: string;
  /** 要約本文 */
  summary: string;
  /** 主要語（検索・語彙候補に使う） */
  keywords: string[];
  /** 重要度（言及量・新しさ） */
  salience: number;
  startedAt: string;
  endedAt: string;
  updatedAt: string;
}

/**
 * 行動指針（谺自身の振る舞いを制御する自己知識）. 会話で受けた指示・訂正・
 * 教訓を蓄え, 応答時にシステムプロンプトへ差し込んで参照する.
 * 知識は時間とともに陳腐化しうるため, updatedAt を起点に半減期で鮮度が減衰する．
 * 普遍的で変わらないものは permanent=true とし, 減衰の対象外にする.
 */
export interface BehaviorNote {
  id: string;
  /** 指針の本文（例: 論文の要約は結論から述べる） */
  content: string;
  /** 分類: preference | rule | procedure | context | other */
  kind: string;
  /** 恒久的（陳腐化しない普遍的な原則）か */
  permanent: boolean;
  /** 重要度（プロンプト注入の優先順に使う） */
  weight: number;
  /** 鮮度の半減期（日）. permanent=false のときのみ意味を持つ */
  halfLifeDays: number;
  /** 有効か（廃止された指針は false で残す） */
  active: boolean;
  createdAt: string;
  /** 最終確認時刻（鮮度の起点．再確認で更新される） */
  updatedAt: string;
}

/**
 * アップロードされたファイルのメタデータ. 実体（バイナリ）はSQLiteの
 * files テーブルにBLOBで格納し, /api/files/:id でいつでも取り出せる.
 */
export interface FileRecord {
  id: string;
  /** 元のファイル名 */
  name: string;
  /** MIMEタイプ（例: application/pdf） */
  mimeType: string;
  /** バイト数 */
  size: number;
  createdAt: string;
}

/** 横断検索（searchAll）の1ヒット. 会話・トピック・メモ・語彙を統一形で返す（§15.3）. */
export interface SearchHit {
  /** 出所: message | topic | memory | term */
  source: "message" | "topic" | "memory" | "term";
  id: string;
  /** 見出し（トピック名・メモ種別・語の表記など） */
  title: string;
  /** 本文・抜粋 */
  snippet: string;
  /** 並び替え用の時刻（ISO） */
  at: string;
}

/**
 * バックエンド → Web UI へWebSocketで配信するイベント.
 * 状態機械の遷移や文字起こし・応答デルタをリアルタイム可視化する.
 */
export type ServerEvent =
  | { type: "state"; state: AssistantState }
  | { type: "presence"; present: boolean }
  | { type: "transcript"; final: boolean; text: string; speaker?: string }
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_done"; messageId: string }
  /** マイクが拾っている音量レベル（0〜1）．UIエージェントの反応に用いる */
  | { type: "audio"; level: number }
  /** ローカルWhisperによる常時文字起こし（ライブ字幕） */
  | { type: "stt"; text: string }
  /** 思考中の作業内容（ツール実行など）．空文字でクリア */
  | { type: "status"; text: string }
  /** Claudeが生成したUI（HTML/CSS）をサンドボックスiframeへ描画する（§15.4） */
  | {
      type: "ui_render";
      id: string;
      html: string;
      css?: string;
      title?: string;
      /** 経過後に自動で消す（ms）．未指定なら残す */
      ttlMs?: number;
      /** スクリプトを有効化して対話的UIにするか（既定は静的表示） */
      interactive?: boolean;
    }
  /** 実ブラウザ（既定ブラウザ/新規タブ）でURLを開く（検索結果の表示など, §15.4） */
  | { type: "ui_open_url"; url: string; title?: string }
  /** ダウンロード可能なファイルができたとき, 画面にダウンロードカードを表示する */
  | {
      type: "ui_download";
      id: string;
      /** カードの見出し（例: 会議メモをまとめました） */
      title?: string;
      /** ダウンロードできるファイル（/api/files/:id で取得） */
      files: FileRecord[];
    }
  /** ファイルが必要な場面で, アップロードエリア（ドラッグ&ドロップ）を一時表示する */
  | {
      type: "ui_upload";
      id: string;
      /** エリアに表示する依頼文（例: 査読対象のPDFをここへ） */
      title?: string;
      /** 受け付ける種別（input の accept 形式, 例: ".pdf,image/*"） */
      accept?: string;
      /** 複数ファイルを受け付けるか（既定 true） */
      multiple?: boolean;
    }
  /** 生成UIパネルを消す（id指定で個別, 省略で全消去） */
  | { type: "ui_clear"; id?: string }
  | { type: "error"; message: string };

/** Web UI → バックエンド へのコマンド */
export type ClientCommand =
  | { type: "text_input"; text: string }
  | { type: "interrupt" }
  | { type: "wake" }
  | { type: "set_persona"; persona: Partial<PersonaConfig> }
  /** 生成UI(iframe)内のフォーム等からの操作イベント（谺への入力として扱う, §15.4） */
  | { type: "ui_event"; name: string; value: string }
  /** アップロードエリア（ui_upload）の結果．保存済みファイルのメタを谺への入力として返す */
  | {
      type: "files_uploaded";
      /** 対応する ui_upload の id */
      requestId: string;
      /** 受領しDBへ保存したファイル（キャンセル時は空） */
      files: FileRecord[];
      /** ユーザがアップロードせずに閉じたか */
      canceled?: boolean;
    };

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
