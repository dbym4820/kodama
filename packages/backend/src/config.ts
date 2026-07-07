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
  // 応答1回の最大トークン. render_ui等でHTMLを生成すると長くなるため十分に確保する
  // （小さすぎるとツール入力(JSON)が途中で切れて壊れ, 例外＝クラッシュの原因になる）.
  brainMaxTokens: Number(optional("BRAIN_MAX_TOKENS", "8192")),
  // パーソナリティの初期値（会話やWeb UIから変更でき, 変更はローカルDBに永続化される）
  assistantName: optional("ASSISTANT_NAME", "谺"),
  assistantReading: optional("ASSISTANT_READING", "こだま"),
  ownerName: optional("OWNER_NAME", "油谷知岐"),
  ownerReading: optional("OWNER_READING", "あぶらたに ともき"),
  ownerHonorific: optional("OWNER_HONORIFIC", "油谷さん"),
  // 応答ゲート: 常時聞き取った発話のうち, 谺へ明確に向けられたものだけに応答する.
  // 無効化すると（0）従来どおり全ての発話に応答する.
  addressingGate: bool("ADDRESSING_GATE", true),
  // 在室ゲート: 不在判定のあいだは音声発話に応答しない（TVの音・掃除の人の声などへの
  // 誤応答を防ぐ）. テキスト入力・手動ウェイク等の明示依頼と, 在室検知が停止中
  // （カメラ未設定）のときは適用しない.
  presenceGate: bool("PRESENCE_GATE", true),
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
  // 最初の読み上げチャンクだけに使う小さい閾値．最初の一文が確定した瞬間に
  // 発話を始める（短い応答でも全文生成を待たない）.
  // 「承知しました．」(7字) のような相槌の一文が単独で即発火する値にする.
  ttsFirstMinChars: Number(optional("TTS_FIRST_MIN_CHARS", "6")),

  // 自己改修（谺が自分のソースコードを承認制で書き換え, 再起動する機能）.
  selfMod: bool("SELF_MOD", true),

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

  // 話者識別（声による個人識別）. 発話ごとに話者埋め込み（sherpa-onnx, 完全ローカル）を
  // 計算し, 登録済みの声とコサイン類似度で照合する. 未登録の声は「ゲストA」等の仮ラベルで
  // 扱い, 名前を教われば enroll_speaker ツールで正式登録される（＝声を覚える）.
  speakerId: bool("SPEAKER_ID", true),
  // 話者埋め込みモデル（ONNX）. 既定は 3D-Speaker CAM++（zh-en汎用, 約28MB）.
  speakerModel: resolve(
    optional(
      "SPEAKER_MODEL",
      "./models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    ),
  ),
  // 本人判定のコサイン類似度閾値. 高いほど厳格（他人拒否寄り）, 低いほど寛容（本人受理寄り）.
  speakerThreshold: Number(optional("SPEAKER_THRESHOLD", "0.45")),
  // 識別に用いる最小発話長（秒）. 短すぎる発話は埋め込みが不安定なため識別しない.
  speakerMinSec: Number(optional("SPEAKER_MIN_SEC", "0.8")),
  // 1話者あたり保持する声サンプル（埋め込み）の上限.
  speakerMaxSamples: Number(optional("SPEAKER_MAX_SAMPLES", "12")),

  // 傾聴モードの無入力タイムアウト（ms）
  listenTimeoutMs: Number(optional("LISTEN_TIMEOUT_MS", "8000")),
  // 返答後に自動で傾聴に入り直す（「こだま」無しで続けて話せる）
  followupListen: bool("FOLLOWUP_LISTEN", true),

  // カメラ在室検知（動き＝フレーム差分 ＋ ONNX人物検出のハイブリッド）
  cameraPollMs: Number(optional("CAMERA_POLL_MS", "1500")),
  // 「変化した」とみなす1画素あたりの輝度差（0〜255）. カメラノイズより大きく.
  presencePixelDiff: Number(optional("PRESENCE_PIXEL_DIFF", "14")),
  // 動きと判定する変化画素の割合（64x64中）. 0.015=約60画素で, タイピング程度も拾う.
  presenceMotionRatio: Number(optional("PRESENCE_MOTION_RATIO", "0.015")),
  // これ以上が一斉に変化したら照明変化・自動露出とみなし動きに数えない.
  presenceGlobalChangeRatio: Number(optional("PRESENCE_GLOBAL_CHANGE_RATIO", "0.7")),
  // 在室の保持時間（秒）. 最後の根拠（動き/人物検出）からこの時間で不在に落とす.
  presenceHoldSec: Number(optional("PRESENCE_HOLD_SEC", "300")),
  // ONNX人物検出の実行間隔（ms）. 静止中でも在室を維持する根拠を補強する.
  presenceDetectIntervalMs: Number(optional("PRESENCE_DETECT_INTERVAL_MS", "30000")),
  // 人物検出モデル（YOLOX-tiny, COCO）. 未配置なら動き検知のみで動作する.
  personModel: resolve(optional("PERSON_MODEL", "./models/yolox_tiny.onnx")),
  // 人物と判定する検出スコアの下限（不在→在室の「入り」判定）.
  // 頭部だけが画面端に見切れたフレームでも実測 ~0.68 が出るため 0.45 で拾える.
  personScoreThreshold: Number(optional("PERSON_SCORE_THRESHOLD", "0.45")),
  // 在室中の「維持」判定に使う緩い下限. 一度在室になれば頭の一部などの弱い検出でも
  // 在室を保つ（空き部屋の誤検出レベルは実測 ~0.004 と十分低い）.
  personScoreSustain: Number(optional("PERSON_SCORE_SUSTAIN", "0.25")),

  // 語彙ヒント（§15.1）: whisperのpromptへ載せる語の上限（prompt長の制約に合わせる）.
  sttHintMaxTerms: Number(optional("STT_HINT_MAX_TERMS", "64")),
  // 自動抽出した語彙の初期weight（user明示登録=1より低くしてヒント上位を譲る）.
  autoTermWeight: Number(optional("AUTO_TERM_WEIGHT", "0.5")),

  // 会話の定期要約（§15.2）.
  digestIntervalMs: Number(optional("DIGEST_INTERVAL_MS", "180000")),
  // 1回の要約で読む未要約メッセージの上限.
  digestBatchMax: Number(optional("DIGEST_BATCH_MAX", "120")),
  // この件数未満なら要約をスキップ（細切れ要約を避ける）.
  digestMinMessages: Number(optional("DIGEST_MIN_MESSAGES", "6")),

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
