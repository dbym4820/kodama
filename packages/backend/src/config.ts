import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

loadEnv();

/**
 * GUI(Finder)から起動したアプリのPATHには /opt/homebrew/bin 等が含まれず,
 * ffmpeg / ffplay / whisper-cli / say を spawn できずデバイス列挙や音声I/Oが失敗する.
 * 代表的な bin ディレクトリをPATHへ補い, ターミナル起動でもGUI起動でも動くようにする.
 */
function ensureBinPath(): void {
  const extra = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const cur = (process.env.PATH ?? "").split(":").filter(Boolean);
  const merged = [...cur, ...extra.filter((p) => !cur.includes(p))];
  process.env.PATH = merged.join(":");
}
ensureBinPath();

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `環境変数 ${name} が未設定です．.env.example を参考に .env を作成してください．`,
    );
  }
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v == null) return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  cameraRtspUrl: process.env.CAMERA_RTSP_URL ?? "",
  // Qwatch APIでRTSP URLを自動解決する場合の接続情報（CAMERA_RTSP_URL未設定時に使用）
  cameraHost: process.env.CAMERA_HOST ?? "",
  cameraUser: process.env.CAMERA_USER ?? "",
  cameraPass: process.env.CAMERA_PASS ?? "",

  // 外部連携（秘書ツール）
  // 研究文献ディレクトリ（ローカル参照）
  papersDir: optional(
    "PAPERS_DIR",
    "/Users/tomoki/Library/CloudStorage/Dropbox/01-Research/01-works/99-References/01-papers",
  ),
  // Notion 連携トークン（未設定ならNotionツールは無効）
  notionToken: process.env.NOTION_TOKEN ?? "",

  // Web検索（Anthropic公式のサーバサイドWeb検索ツール．追加APIキー不要）
  webSearch: bool("WEB_SEARCH", true),
  // 1回の応答での最大検索回数
  webSearchMaxUses: Number(optional("WEB_SEARCH_MAX_USES", "5")),

  brainModel: optional("BRAIN_MODEL", "claude-sonnet-4-6"),
  fastModel: optional("FAST_MODEL", "claude-haiku-4-5-20251001"),
  // パーソナリティの初期値（会話やWeb UIから変更でき, 変更はローカルDBに永続化される）
  assistantName: optional("ASSISTANT_NAME", "谺"),
  assistantReading: optional("ASSISTANT_READING", "こだま"),
  ownerName: optional("OWNER_NAME", "油谷知岐"),
  ownerReading: optional("OWNER_READING", "あぶらたに ともき"),
  ownerHonorific: optional("OWNER_HONORIFIC", "油谷さん"),
  // 応答ゲート: 常時聞き取った発話のうち, 谺へ明確に向けられたものだけに応答する.
  // 無効化すると（0）従来どおり全ての発話に応答する.
  addressingGate: bool("ADDRESSING_GATE", true),
  // 応答時にClaudeへ渡す履歴の範囲（直近メッセージ数）. ゲートが内容から適切な数を判定し,
  // この下限〜上限にクランプする. 自己完結な質問は小さく, 文脈を遡る質問は大きく.
  contextWindowDefault: Number(optional("CONTEXT_WINDOW_DEFAULT", "16")),
  contextWindowMin: Number(optional("CONTEXT_WINDOW_MIN", "4")),
  contextWindowMax: Number(optional("CONTEXT_WINDOW_MAX", "100")),
  sttModel: optional("STT_MODEL", "gpt-4o-transcribe"),
  // STTの言語アンカー（短い発話の他言語誤認識を防ぐ日本語コンテキスト）
  sttPrompt: optional("STT_PROMPT", "研究室での日本語の会話です．"),
  // 完全ローカルの常時ストリーミングSTT（whisper.cpp / whisper-server 常駐）.
  // ウェイクワード不要で待機中も常時マイクを聞き, 発話中は partial モデルで途中経過を,
  // 発話確定時は final（最高精度）モデルで確定文字起こしして会話の起点にする.
  // 音声はクラウドへ送らず完結する（ローカルファースト）.
  localStreaming: bool("LOCAL_STREAMING", true),
  whisperServerBin: optional("WHISPER_SERVER_BIN", "whisper-server"),
  // final: 確定用の最高精度モデル（既定 large-v3）. partial: 途中表示用の高速モデル（既定 large-v3-turbo）.
  whisperFinalModel: resolve(
    optional("WHISPER_FINAL_MODEL", "./models/ggml-large-v3.bin"),
  ),
  whisperPartialModel: resolve(
    optional("WHISPER_PARTIAL_MODEL", "./models/ggml-large-v3-turbo.bin"),
  ),
  whisperServerThreads: Number(optional("WHISPER_SERVER_THREADS", "6")),
  whisperServerPortFinal: Number(optional("WHISPER_SERVER_PORT_FINAL", "53121")),
  whisperServerPortPartial: Number(
    optional("WHISPER_SERVER_PORT_PARTIAL", "53122"),
  ),
  // 擬似ストリーミングの途中再デコード間隔ms（小さいほど“伸び”が滑らか・CPU増）.
  partialIntervalMs: Number(optional("PARTIAL_INTERVAL_MS", "600")),
  ttsModel: optional("TTS_MODEL", "gpt-4o-mini-tts"),
  ttsVoice: optional("TTS_VOICE", "alloy"),
  // 音声合成エンジン: "say"=ローカル(macOS say) / "openai"=クラウド
  ttsEngine: optional("TTS_ENGINE", "openai"),
  // ローカル say の話者（`say -v '?'` で一覧）
  ttsSayVoice: optional("TTS_SAY_VOICE", "Kyoko"),
  // 音声再生速度（1.0=等速）．ffmpegのatempoで適用するため音程は保たれる.
  ttsSpeed: Number(optional("TTS_SPEED", "1.0")),
  // 読み上げチャンクの最小文字数．大きいほど文をまとめて滑らかに（小さいほど初動が速い）.
  ttsMinChars: Number(optional("TTS_MIN_CHARS", "60")),

  // 音声I/O（入力=ffmpeg avfoundation / 出力=ffmpeg audiotoolbox 経由）
  // 入出力デバイスはWeb UIの設定画面から切り替え・テストでき, 選択はDBに永続化される.
  enableMic: bool("ENABLE_MIC", true),
  // macOS avfoundation の入力デバイス指定（":0" = 既定の音声入力．設定画面の初期値）
  audioInputDevice: optional("AUDIO_INPUT_DEVICE", ":0"),
  // 上記から取り出した音声入力デバイスのインデックス（設定画面の初期選択に使用）
  audioInputIndex: Number(
    (optional("AUDIO_INPUT_DEVICE", ":0").match(/\d+/) ?? ["0"])[0],
  ),
  sampleRate: 16000,
  // 1フレーム = 512サンプル（16kHzで32ms）
  frameSamples: 512,

  // エネルギーVAD（発話区間検出）
  vadThreshold: Number(optional("VAD_THRESHOLD", "0.018")),
  vadStartFrames: Number(optional("VAD_START_FRAMES", "3")),
  vadSilenceFrames: Number(optional("VAD_SILENCE_FRAMES", "25")),
  vadMaxFrames: Number(optional("VAD_MAX_FRAMES", "500")),
  // 発話開始前の取り込みフレーム数（512/16kHz=32ms単位．語頭の欠け防止）
  vadPrerollFrames: Number(optional("VAD_PREROLL_FRAMES", "8")),

  // ローカル Whisper（whisper.cpp CLI）— ウェイクワード照合＋常時文字起こしに使用
  whisperBin: optional("WHISPER_BIN", "whisper-cli"),
  // 相対指定（例 ./models/ggml-small.bin）は実行ディレクトリ基準で絶対化する.
  // dev は cwd=リポジトリ直下, パッケージ版は cwd=resources のため, 同梱モデル
  // （extraResources で resources/models へ配置）に自動で解決される.
  whisperModel: process.env.WHISPER_MODEL
    ? resolve(process.env.WHISPER_MODEL)
    : "",
  whisperLanguage: optional("WHISPER_LANGUAGE", "ja"),

  // ウェイクワード（ローカルWhisperで文字起こし→照合する呼びかけフレーズ）
  // Whisperは「こだま」を文脈で 谺/木霊/木魂/小玉/コダマ 等に変換するため同音異字を網羅する
  wakewordPhrases: optional("WAKEWORD_PHRASES", "谺,こだま,コダマ,木霊,木魂,小玉,児玉,kodama")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // 発話中の中断フレーズ（音声での停止）. 発話中にこれらを聞き取ると読み上げを止める.
  stopPhrases: optional("STOP_PHRASES", "ストップ,すとっぷ,止まって,止まれ,やめて,黙って,stop")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // ウェイクワード切り出しの発話上限フレーム（512サンプル/32ms × 150 ≒ 4.8秒）
  wakeMaxFrames: Number(optional("WAKE_MAX_FRAMES", "150")),
  // ウェイクワードは短いので無音判定を短くして検知を速める（12フレーム ≒ 0.38秒）
  wakeSilenceFrames: Number(optional("WAKE_SILENCE_FRAMES", "12")),
  // 発話中の割り込み判定で使うVAD閾値の倍率（アシスタント音声の回り込みを避けるため高め）
  bargeThresholdMult: Number(optional("BARGE_THRESHOLD_MULT", "2.2")),
  // 発話中の一般バージイン: フレーズ（「こだま」「ストップ」）に依らず, 一定以上の声を
  // 出し始めたら読み上げを止めて傾聴へ切り替える. しきい値は vadThreshold×bargeThresholdMult.
  // ※エコーキャンセル無しのため, スピーカー使用で自己中断する場合は 0 で無効化するか
  //   BARGE_THRESHOLD_MULT を上げる（ヘッドホン推奨）.
  bargeIn: bool("BARGE_IN", true),
  // バージイン成立に必要な連続フレーム数（4≒128ms）. 大きいほど誤検知に強いが反応は鈍る.
  bargeStartFrames: Number(optional("BARGE_START_FRAMES", "4")),

  // 傾聴モードの無入力タイムアウト（ms）
  listenTimeoutMs: Number(optional("LISTEN_TIMEOUT_MS", "8000")),
  // 返答後に自動で傾聴に入り直す（「こだま」無しで続けて話せる）
  followupListen: bool("FOLLOWUP_LISTEN", true),

  // カメラ在室検知（フレーム差分）
  cameraPollMs: Number(optional("CAMERA_POLL_MS", "1500")),
  presenceThreshold: Number(optional("PRESENCE_THRESHOLD", "8")),

  dataDir: resolve(optional("DATA_DIR", "./data")),
  port: Number(optional("PORT", "52525")),
  // ビルド済みフロントエンド(dist)の配信元．未指定時は index.ts が既定パスを算出する.
  frontendDist: process.env.FRONTEND_DIST ?? "",

  /** 鍵が揃っているか（疎通確認用） */
  requireKeys() {
    return {
      anthropic: required("ANTHROPIC_API_KEY"),
      openai: required("OPENAI_API_KEY"),
    };
  },
};

export type Config = typeof config;

/** マイク感度（1=鈍感〜10=敏感）→ VAD閾値. 感度が高いほど閾値は低い. */
export function sensitivityToThreshold(sensitivity: number): number {
  const s = Math.min(10, Math.max(1, sensitivity));
  return 0.035 - ((s - 1) / 9) * (0.035 - 0.008);
}

/** VAD閾値 → マイク感度（1〜10, 整数）. */
export function thresholdToSensitivity(threshold: number): number {
  const s = ((0.035 - threshold) / (0.035 - 0.008)) * 9 + 1;
  return Math.round(Math.min(10, Math.max(1, s)));
}
