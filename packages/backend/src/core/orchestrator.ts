import {
  AssistantState,
  DEFAULT_SHORTCUTS,
  type AudioDevicesInfo,
  type AudioInputTest,
  type CameraInfo,
  type CameraSettings,
  type CameraTestResult,
  type ClientCommand,
  type MessageRecord,
  type PersonaConfig,
  type ServerEvent,
  type ShortcutSettings,
  type SpeakerRecord,
} from "@kodama/shared";
import {
  config,
  sensitivityToThreshold,
  thresholdToSensitivity,
} from "../config.js";
import { Store } from "../memory/store.js";
import { StateMachine } from "./stateMachine.js";
import { Sentencer } from "./sentencer.js";
import { ClaudeClient, buildInstructions, defaultPersona } from "../brain/claudeClient.js";
import type { ToolContext, SettingsController } from "../brain/tools.js";
import { SelfMod } from "../brain/selfmod.js";
import { TopicDigester } from "./topicDigester.js";
import { OpenAIStt } from "../stt/openaiStt.js";
import { LocalStreamingStt } from "../stt/localStreamingStt.js";
import { OpenAITts } from "../tts/openaiTts.js";
import type { Tts } from "../tts/types.js";
import { Lexicon, type LexEntry } from "../tts/lexicon.js";
import { stripMarkdown } from "../tts/stripMarkdown.js";
import { FfmpegInput } from "../audio/ffmpegInput.js";
import { FfmpegOutput } from "../audio/ffmpegOutput.js";
import {
  listInputDevices,
  listOutputDevices,
  captureInputLevel,
  playTestTone,
} from "../audio/devices.js";
import { SpeechSegmenter, frameRms } from "../audio/vad.js";
import { WakeWord } from "../perception/wakeword.js";
import { CameraPresence, probeRtsp } from "../perception/camera.js";
import { PersonDetector } from "../perception/personDetect.js";
import { SpeakerIdentifier, type SpeakerMatch } from "../perception/speakerId.js";
import { QwatchClient } from "../perception/qwatch.js";
import { pcmToWav } from "../audio/wav.js";

/** ツール実行中にUIへ出す作業内容（思考モードの可視化）. */
const TOOL_STATUS: Record<string, string> = {
  get_current_time: "時刻を確認中…",
  get_room_state: "在室状況を確認中…",
  remember: "記憶中…",
  recall: "記憶を想起中…",
  register_reading: "読みを登録中…",
  get_settings: "設定を確認中…",
  set_speech_speed: "話速を変更中…",
  set_voice: "声を変更中…",
  set_voice_tone: "口調を変更中…",
  set_identity: "名前・主人を変更中…",
  set_mic_sensitivity: "マイク感度を変更中…",
  enroll_speaker: "声を覚えています…",
  list_speakers: "登録話者を確認中…",
  rename_speaker: "話者名を変更中…",
  forget_speaker: "話者の登録を削除中…",
  search_papers: "文献を検索中…",
  read_paper: "文献を読み込み中…",
  search_history: "過去の記録を検索中…",
  learn_term: "語彙を登録中…",
  open_url: "ブラウザで開いています…",
  render_ui: "画面を生成中…",
  learn_behavior: "行動指針を記憶中…",
  list_behaviors: "行動指針を確認中…",
  update_behavior: "行動指針を更新中…",
  save_file: "ファイルを作成中…",
  list_files: "ファイルを確認中…",
  offer_file_download: "ダウンロードを準備中…",
  request_file_upload: "アップロードエリアを表示中…",
  web_search: "Web検索中…",
  notion_search: "Notionを検索中…",
  notion_get_page: "Notionページを読み込み中…",
  notion_append: "Notionに追記中…",
  notion_create_page: "Notionページを作成中…",
  self_list_source: "自分のソースを確認中…",
  self_read_source: "自分のソースを読解中…",
  self_stage_change: "自己改修を組み立て中…",
  self_validate_changes: "自己改修を検証中…",
  self_discard_changes: "変更を破棄中…",
  self_restart: "再起動を準備中…",
};

const DEFAULT_PERSONA: PersonaConfig = defaultPersona();

/**
 * 谺の中核. 知覚（ウェイクワード/カメラ）→ STT → Claude → TTS → 再生 を配線し,
 * 状態機械とWebSocket配信を統括する. マイク無し環境ではテキスト入力経路で
 * 頭脳＋音声パイプライン全体を駆動できる.
 */
export class Orchestrator {
  private sm = new StateMachine();
  private sessionId!: string;
  private history: MessageRecord[] = [];
  private persona: PersonaConfig = DEFAULT_PERSONA;
  private present = false;
  private digester!: TopicDigester;

  private input: FfmpegInput | null = null;
  private output = new FfmpegOutput();
  private wake = new WakeWord();
  // 話者識別（声による個人識別）. モデル未整備なら init 時に自動で無効化される.
  private speakers: SpeakerIdentifier | null = null;
  private lexicon!: Lexicon;
  private camera: CameraPresence | null = null;
  // ONNX人物検出（在室検知の補助）. モデル未整備なら初回起動時に自動で無効化される.
  private personDetector: PersonDetector | null = null;
  // 稼働中カメラの解決済みRTSP URL（設定画面のライブプレビュー配信に使う）.
  private cameraUrl = "";
  private segmenter = new SpeechSegmenter(
    config.vadThreshold,
    config.vadStartFrames,
    config.vadSilenceFrames,
    config.vadMaxFrames,
    config.vadPrerollFrames,
  );

  // 完全ローカルの常時ストリーミングSTT（whisper-server 常駐）. 起動前は wake+バッチへ降格.
  private localStt: LocalStreamingStt | null = config.localStreaming
    ? new LocalStreamingStt()
    : null;
  // 進行中の部分文字起こし（ライブ表示用テキスト）.
  private streamPartial = "";
  // 直近フレームのリングバッファ（バージイン時に発話の語頭を取りこぼさず引き継ぐ）.
  private recentFrames: Buffer[] = [];
  // 発話中バージイン: 連続して閾値を超えた音声フレーム数.
  private bargeCount = 0;

  private speakChain: Promise<void> = Promise.resolve();
  private speakAborted = false;
  private listenTimer: NodeJS.Timeout | null = null;
  // 進行中の応答生成を中断するためのコントローラ（停止ボタン/音声中断で abort）.
  private respondAbort: AbortController | null = null;
  // 手動ウェイク（谺ボタン）直後の発話は明示依頼として扱う（応答ゲートを通さない）.
  private expectAddressed = false;

  // 自己改修（承認制の自書き換え）. self_restart で予約され, 読み上げ完了後に適用・再起動する.
  private selfmod = new SelfMod();
  private pendingRestartNote: string | null = null;

  // マイク音量レベルの配信（UIエージェントのピクつき反応用）
  private audioFrameCount = 0;
  private audioLevelMax = 0;

  // 実行時に変更されるマイク感度のVAD閾値
  private micThreshold = config.vadThreshold;

  // 選択中の音声入力デバイス（avfoundation音声インデックス）
  private inputIndex = config.audioInputIndex;
  // 入力テスト中のピーク音量を拾うプローブ（テスト時のみ有効）
  private inputProbe: { peak: number } | null = null;

  constructor(
    private store: Store,
    private claude: ClaudeClient = new ClaudeClient(),
    private stt: OpenAIStt = new OpenAIStt(),
    private tts: Tts = new OpenAITts(),
    private broadcast: (ev: ServerEvent) => void = () => {},
  ) {}

  private get toolCtx(): ToolContext {
    return {
      store: this.store,
      getPresence: () => this.present,
      getState: () => this.sm.state,
      lexicon: this.lexicon,
      settings: this.settingsCtl,
      speakers: this.speakers ?? undefined,
      emit: (ev) => this.broadcast(ev),
      selfmod: this.selfmod,
      requestRestart: (note) => {
        this.pendingRestartNote = note;
      },
    };
  }

  /**
   * STTの認識バイアス用ヒント（§15.1）.
   * 登録語彙(terms)の表記を重み順で並べ, 発音辞書の固有名詞と合わせて
   * whisperのpromptへ動的に差し込む. 語彙更新は次の推論から即反映される.
   */
  private sttHint(): string {
    const terms = this.store.termHintSurfaces(config.sttHintMaxTerms);
    const lex = this.lexicon?.list().map((e) => e.surface) ?? [];
    const uniq = Array.from(new Set([...terms, ...lex])).slice(
      0,
      config.sttHintMaxTerms,
    );
    if (!uniq.length) return "";
    return `固有名詞: ${uniq.join("，")}．`;
  }

  /** 会話（Claudeツール）から谺の設定を変更・参照するコントローラ. */
  private get settingsCtl(): SettingsController {
    const clamp = (v: number, lo: number, hi: number) =>
      Math.min(hi, Math.max(lo, v));
    return {
      view: () => ({
        speechSpeed: Math.round(this.output.speed * 100) / 100,
        voice: this.persona.voice,
        voiceTone: this.persona.voiceInstructions,
        micSensitivity: thresholdToSensitivity(this.micThreshold),
        name: this.persona.name,
        nameReading: this.persona.nameReading,
        owner: this.persona.owner,
        ownerReading: this.persona.ownerReading,
        ownerHonorific: this.persona.ownerHonorific,
      }),
      setIdentity: (id) => {
        this.persona = {
          ...this.persona,
          ...(id.name !== undefined ? { name: id.name } : {}),
          ...(id.nameReading !== undefined ? { nameReading: id.nameReading } : {}),
          ...(id.owner !== undefined ? { owner: id.owner } : {}),
          ...(id.ownerReading !== undefined ? { ownerReading: id.ownerReading } : {}),
          ...(id.ownerHonorific !== undefined
            ? { ownerHonorific: id.ownerHonorific }
            : {}),
        };
        this.store.setSetting("persona", this.persona);
      },
      setSpeechSpeed: (speed) => {
        this.output.speed = clamp(speed, 0.5, 2.0);
        this.persistRuntime();
      },
      setVoice: (voice) => {
        this.persona = { ...this.persona, voice };
        this.store.setSetting("persona", this.persona);
      },
      setVoiceTone: (instructions) => {
        this.persona = { ...this.persona, voiceInstructions: instructions };
        this.store.setSetting("persona", this.persona);
      },
      setMicSensitivity: (sensitivity) => {
        this.applyMicThreshold(sensitivityToThreshold(clamp(sensitivity, 1, 10)));
        this.persistRuntime();
      },
    };
  }

  /** マイク感度（VAD閾値）を全セグメンタへ反映する. */
  private applyMicThreshold(threshold: number): void {
    this.micThreshold = threshold;
    this.segmenter.setThreshold(threshold);
    this.wake.setThreshold(threshold);
    this.localStt?.setThreshold(threshold);
  }

  private persistRuntime(): void {
    this.store.setSetting("runtime", {
      ttsSpeed: this.output.speed,
      vadThreshold: this.micThreshold,
    });
  }

  async start(): Promise<void> {
    this.sessionId = this.store.createSession().id;
    // 保存済みパーソナリティを復元. 旧スキーマ（name 無し）は声設定だけ引き継ぎ,
    // 旧来の固定指示文は破棄して新テンプレート（buildInstructions）に統一する.
    const stored = this.store.getSetting<Partial<PersonaConfig>>("persona");
    this.persona = {
      ...DEFAULT_PERSONA,
      ...(stored?.voice ? { voice: stored.voice } : {}),
      ...(stored?.voiceInstructions
        ? { voiceInstructions: stored.voiceInstructions }
        : {}),
      ...(stored?.name
        ? {
            name: stored.name,
            nameReading: stored.nameReading,
            owner: stored.owner ?? DEFAULT_PERSONA.owner,
            ownerReading: stored.ownerReading,
            ownerHonorific: stored.ownerHonorific,
            instructions: stored.instructions ?? "",
          }
        : {}),
    };
    this.lexicon = new Lexicon(this.store);
    this.lexicon.load();

    // 常時ストリーミングSTTへ語彙ヒントを動的供給する（登録語が次の推論から効く, §15.1）.
    this.localStt?.setHintProvider(() => this.sttHint());

    // 話者識別（声による個人識別）. モデル・アドオン未整備なら自動で無効化される.
    if (config.speakerId) {
      this.speakers = new SpeakerIdentifier(this.store);
      void this.speakers.init();
    }

    // 会話の定期要約ジョブを起動する（§15.2）.
    this.digester = new TopicDigester(this.store, this.claude);
    this.digester.start();

    // 会話で変更された実行時設定（話速・マイク感度）を復元する.
    const rt = this.store.getSetting<{ ttsSpeed?: number; vadThreshold?: number }>(
      "runtime",
    );
    if (rt?.ttsSpeed) this.output.speed = rt.ttsSpeed;
    this.applyMicThreshold(rt?.vadThreshold ?? config.vadThreshold);

    // 設定画面で選んだ入出力デバイスを復元する.
    const dev = this.store.getSetting<{
      inputIndex?: number;
      outputIndex?: number;
    }>("audioDevices");
    if (typeof dev?.inputIndex === "number") this.inputIndex = dev.inputIndex;
    if (typeof dev?.outputIndex === "number") {
      this.output.deviceIndex = dev.outputIndex;
    }

    this.sm.onChange((state) => this.broadcast({ type: "state", state }));

    // ウェイクワード（ローカルWhisper）
    // IDLE: 起動．SPEAKING: 発話を中断してユーザーの音声入力へ切り替える（割り込み）.
    // ローカルWhisperの文字起こしを常時ライブ字幕としてUIへ配信.
    this.wake.onTranscribed((text) => this.broadcast({ type: "stt", text }));
    this.wake.onDetected(() => {
      const st = this.sm.state;
      if (st === AssistantState.SPEAKING) this.interrupt();
      if (st === AssistantState.IDLE || st === AssistantState.SPEAKING) {
        this.beginListening();
      }
    });
    const wakeOk = await this.wake.init();
    if (wakeOk) {
      console.log("[wakeword] ローカルWhisperで監視開始");
    } else {
      console.log(
        "[wakeword] 無効（whisperバイナリ/モデル未設定）．手動ウェイク（Web UI）で起動できます．",
      );
    }

    // 完全ローカルの常時ストリーミングSTT（whisper-server）. 起動でマイクを常時聴取する.
    if (this.localStt) void this.initLocalStt();

    // マイク入力
    if (config.enableMic) this.startMic();

    // カメラ在室検知（設定画面で保存した接続設定 > 環境変数を初期値に起動）
    await this.startCamera();

    // 自己改修の再起動から復帰した場合: 直前の会話を引き継ぎ, 結果を口頭報告する.
    this.handleSelfmodBoot();
  }

  /**
   * 自己改修（self_restart）による再起動からの復帰処理.
   * 再開マーカー（selfmodResume）があれば直前セッションの履歴を引き継いで会話を継続し,
   * 適用成功（note）または監督プロセスによる巻き戻しを主人へ口頭報告する.
   * 併せて pending.json を消し, 起動成功を監督プロセスへ宣言する.
   */
  private handleSelfmodBoot(): void {
    const resume = this.store.getSetting<{
      prevSessionId: string;
      note: string;
      at: string;
    }>("selfmodResume");
    if (resume) this.store.setSetting("selfmodResume", null);
    const rolled = this.selfmod.consumeRollback();
    this.selfmod.markBootOk();
    if (!resume && !rolled) return;

    // 直前セッションの会話履歴を読み込み, 再起動をまたいで文脈を継続する.
    if (
      resume?.prevSessionId &&
      Date.now() - Date.parse(resume.at) < 10 * 60_000
    ) {
      this.history.push(...this.store.recentMessages(resume.prevSessionId, 40));
    }

    const msg = rolled
      ? "申し訳ありません．先ほどの自己改修は再起動に失敗したため，変更を巻き戻して復旧しました．原因を調べ直しますので，改めてお申し付けください．"
      : resume?.note?.trim() ||
        "自己改修を適用し，再起動が完了しました．続きをどうぞ．";
    const rec = this.store.addMessage({
      sessionId: this.sessionId,
      role: "assistant",
      text: msg,
    });
    this.history.push(rec);
    this.broadcast({ type: "assistant_delta", text: msg });
    this.broadcast({ type: "assistant_done", messageId: rec.id });
    this.speak(msg);
    void this.speakChain.then(() => {
      if (this.sm.state === AssistantState.SPEAKING) {
        this.setState(AssistantState.IDLE);
      }
    });
  }

  // --- マイク入力（起動・停止・切替） ---------------------------------

  /** 現在の inputIndex で avfoundation マイク取り込みを起動する. */
  private startMic(): void {
    try {
      this.input = new FfmpegInput(
        `:${this.inputIndex}`,
        config.sampleRate,
        config.frameSamples,
      );
      this.input.on("frame", (f: Buffer) => this.onFrame(f));
      this.input.on("error", (e: Error) =>
        console.log("[mic] ffmpeg起動失敗（ffmpeg未導入の可能性）:", e.message),
      );
      this.input.start();
      console.log(`[mic] 取り込み開始（device :${this.inputIndex}）`);
    } catch (e) {
      console.log("[mic] 無効化:", (e as Error).message);
    }
  }

  /** マイク取り込みを停止する. */
  private stopMic(): void {
    this.input?.stop();
    this.input = null;
  }

  // --- ストリーミングSTT（Realtime API） -------------------------------

  /** ローカル常時STT（whisper-server）を起動し, 文字起こしを会話パイプラインへ配線する. */
  private async initLocalStt(): Promise<void> {
    const s = this.localStt!;
    s.setThreshold(this.micThreshold);

    s.on("ready", () =>
      console.log("[local-stt] 常時ストリーミングSTTを開始（whisper-server 常駐）"),
    );
    s.on("speechStarted", () => {
      // 待機中に発話を検知したら傾聴状態へ（ウェイクワード不要の常時聴取）.
      if (this.sm.state === AssistantState.IDLE) {
        this.clearListenTimer();
        this.setState(AssistantState.LISTENING);
      }
      this.streamPartial = "";
    });
    s.on("partial", (text: string) => {
      const st = this.sm.state;
      if (st !== AssistantState.IDLE && st !== AssistantState.LISTENING) return;
      // 確定前の途中経過をライブ配信（UIで薄く表示, 擬似ストリーミング）.
      this.streamPartial = text;
      this.broadcast({ type: "transcript", final: false, text });
    });
    s.on("final", (text: string, pcm: Buffer) => {
      const st = this.sm.state;
      if (st !== AssistantState.IDLE && st !== AssistantState.LISTENING) return;
      void this.onStreamingFinal(text, pcm);
    });

    try {
      await s.start();
    } catch (e) {
      console.log(
        "[local-stt] 起動失敗（whisper-server/モデル未整備, ウェイクワード経路で代替）:",
        (e as Error).message,
      );
    }
  }

  /** ストリーミングSTTが返した確定発話を会話へ渡す. */
  private async onStreamingFinal(text: string, pcm: Buffer): Promise<void> {
    const clean = text.trim();
    this.streamPartial = "";
    if (!clean) {
      // 空確定（雑音など）は無視し, 待機（常時聴取）へ戻す.
      if (this.sm.state === AssistantState.LISTENING) {
        this.setState(AssistantState.IDLE);
      }
      return;
    }
    this.clearListenTimer();

    // 確定発話の音声を履歴として保存する（任意・失敗は無視）.
    let audioPath: string | null = null;
    try {
      const wav = pcmToWav(pcm, config.sampleRate);
      audioPath = this.store.saveAudio(this.sessionId, "user", wav);
    } catch {
      /* 保存失敗は無視 */
    }

    // 話者識別: 発話の声から誰が話したかを判定する（未登録は「ゲスト◯」の仮ラベル）.
    const speaker = this.identifySpeaker(pcm);

    // 常時聞き取り: 履歴に残しつつ, 谺へ向けられた発話だけに応答する.
    await this.handleUtterance(clean, { audioPath, speaker: speaker?.label ?? null });
  }

  /** 発話PCMの話者を識別する（無効・短すぎ・失敗は null）. */
  private identifySpeaker(pcm: Buffer): SpeakerMatch | null {
    if (!this.speakers?.available) return null;
    const m = this.speakers.classify(pcm);
    if (m) {
      console.log(
        `[speaker-id] ${m.label}（${m.known ? "登録済" : "未登録"}, 類似度 ${m.score.toFixed(3)}）`,
      );
    }
    return m;
  }

  /** ローカル常時STTが起動済みか. */
  private streamingActive(): boolean {
    return !!this.localStt && this.localStt.isReady;
  }

  // --- 音声フレーム処理 ------------------------------------------------

  private onFrame(frame: Buffer): void {
    // 入力デバイスのテスト中は, 拾えた最大音量を記録する.
    if (this.inputProbe) {
      const r = frameRms(frame);
      if (r > this.inputProbe.peak) this.inputProbe.peak = r;
    }

    // 状態に関わらず, マイクが拾っている音量を一定間隔でUIへ配信する.
    this.emitAudioLevel(frame);

    // バージインで語頭を引き継ぐための直近フレーム保持（プリロール＋判定分）.
    this.recentFrames.push(frame);
    const keep = config.vadPrerollFrames + config.bargeStartFrames + 2;
    if (this.recentFrames.length > keep) this.recentFrames.shift();

    const st = this.sm.state;

    // 割り込み（バージイン）: 発話中はアシスタント音声の回り込みを避けつつ, 高い閾値の
    // 区間検出でユーザーの「こだま」「ストップ」を拾って中断する. さらに bargeIn 有効時は
    // フレーズに依らず, 一定以上の声を出し始めたら中断して傾聴へ切り替える.
    // 常時STT未起動時は待機中もウェイクワードを照合する（フォールバック）.
    if (st === AssistantState.SPEAKING) {
      this.wake.feedDuringSpeech(frame);
      if (config.bargeIn && this.detectEnergyBarge(frame)) {
        this.bargeInterrupt();
        return;
      }
    } else if (!this.streamingActive()) {
      this.wake.feed(frame);
    }

    if (this.streamingActive()) {
      // 完全常時ストリーミング: 待機/傾聴中はマイクをローカルSTTへ流し続ける.
      // THINKING/SPEAKING 中は止めて自己音声・処理中音声を拾わない.
      if (st === AssistantState.IDLE || st === AssistantState.LISTENING) {
        this.localStt!.feed(frame);
      }
    } else if (st === AssistantState.LISTENING) {
      // フォールバック: 従来のエネルギーVAD＋一括文字起こし.
      const { event, utterance } = this.segmenter.feed(frame);
      if (event === "end" && utterance) {
        this.clearListenTimer();
        void this.onUtterance(utterance);
      }
    }
  }

  /** 数フレームごとにマイク音量(0〜1)を配信する（送り過ぎを抑制）. */
  private emitAudioLevel(frame: Buffer): void {
    const rms = frameRms(frame);
    if (rms > this.audioLevelMax) this.audioLevelMax = rms;
    if (++this.audioFrameCount >= 3) {
      // VAD閾値の数倍でフルスケールになるよう正規化する.
      const level = Math.min(1, this.audioLevelMax / (config.vadThreshold * 4));
      this.broadcast({ type: "audio", level });
      this.audioFrameCount = 0;
      this.audioLevelMax = 0;
    }
  }

  private beginListening(): void {
    this.wake.reset();
    this.segmenter.reset();
    this.localStt?.reset();
    this.streamPartial = "";
    this.setState(AssistantState.LISTENING);
    if (this.streamingActive()) {
      // 常時ストリーミング中は待機(IDLE)でも聴取が続くため無入力タイムアウトは不要.
      this.clearListenTimer();
    } else {
      this.armListenTimeout();
    }
  }

  /** 一定時間 発話が無ければ待機へ戻すタイマーを張り直す（フォールバック経路用）. */
  private armListenTimeout(): void {
    this.clearListenTimer();
    this.listenTimer = setTimeout(() => {
      if (this.sm.state === AssistantState.LISTENING) {
        this.setState(AssistantState.IDLE);
      }
    }, config.listenTimeoutMs);
  }

  private clearListenTimer(): void {
    if (this.listenTimer) clearTimeout(this.listenTimer);
    this.listenTimer = null;
  }

  private async onUtterance(pcm: Buffer): Promise<void> {
    this.setState(AssistantState.THINKING);
    const wav = pcmToWav(pcm, config.sampleRate);
    let audioPath: string | null = null;
    try {
      audioPath = this.store.saveAudio(this.sessionId, "user", wav);
    } catch {
      /* 保存失敗は無視 */
    }
    try {
      // 日本語コンテキスト＋登録語彙でSTTを誘導（短い発話の他言語誤認識を防ぐ, §15.1）.
      const prompt = `${config.sttPrompt}${this.sttHint()}`;
      const text = await this.stt.transcribe(wav, { prompt });
      const speaker = this.identifySpeaker(pcm);
      // フォールバック経路はウェイクワード起動後なので明示依頼として扱う.
      await this.handleUtterance(text, {
        audioPath,
        explicit: true,
        speaker: speaker?.label ?? null,
      });
    } catch (e) {
      this.broadcast({ type: "error", message: `STT失敗: ${(e as Error).message}` });
      this.setState(AssistantState.IDLE);
    }
  }

  // --- 会話処理 --------------------------------------------------------

  /** 発話を必ず履歴へ記録する（応答の有無に関わらず常に残す）. */
  private recordUtterance(
    text: string,
    audioPath: string | null = null,
    speaker: string | null = null,
  ) {
    const rec = this.store.addMessage({
      sessionId: this.sessionId,
      role: "user",
      text,
      audioPath,
      speaker,
    });
    this.history.push(rec);
    this.broadcast({
      type: "transcript",
      final: true,
      text,
      ...(speaker ? { speaker } : {}),
    });
    return rec;
  }

  /** 発話に呼びかけ（設定中のアシスタント名＋ウェイクワード）が含まれるか. */
  private hasWakeName(text: string): boolean {
    const norm = text.toLowerCase().replace(/[\s、。，．！？!?.,「」『』"'・]/g, "");
    const names = [
      this.persona.name,
      this.persona.nameReading,
      ...config.wakewordPhrases,
    ].filter((s): s is string => !!s);
    return names.some((p) => norm.includes(p.toLowerCase()));
  }

  /**
   * 1発話を処理する. 常時聞き取りでは全発話を履歴に残しつつ, 谺へ明確に向けられた
   * 発話だけに応答する（複数人の雑談には黙って聞くだけ）. explicit=true（テキスト入力や
   * 手動ウェイク直後）は判定を飛ばして必ず応答する.
   */
  private async handleUtterance(
    text: string,
    opts: {
      audioPath?: string | null;
      explicit?: boolean;
      speaker?: string | null;
    } = {},
  ): Promise<void> {
    const clean = text.trim();
    if (!clean) {
      if (this.sm.state === AssistantState.LISTENING) {
        this.setState(AssistantState.IDLE);
      }
      return;
    }
    // どんな発話も履歴に残す（話者識別の結果があれば併せて記録する）.
    this.recordUtterance(clean, opts.audioPath ?? null, opts.speaker ?? null);

    const explicit = opts.explicit || this.expectAddressed;
    this.expectAddressed = false;
    const wakeNamed = this.hasWakeName(clean);

    let contextWindow = config.contextWindowDefault;
    let respond = explicit || wakeNamed;

    if (config.presenceGate && this.camera && !this.present && !explicit) {
      // 在室ゲート: 不在のあいだは音声発話に応答しない（履歴には残す）.
      // TVの音や第三者の声への誤応答を防ぐ. テキスト入力・手動ウェイク（explicit）は
      // 通し, 在室検知が停止中（camera=null）のときは適用しない.
      respond = false;
    } else if (config.addressingGate && !explicit) {
      // 谺宛か＋必要な履歴範囲を高速モデルで判定（呼びかけ有りは応答を確定させる保険）.
      const c = await this.claude.classifyTurn({
        recent: this.history.slice(-13, -1),
        utterance: clean,
        name: this.persona.name,
      });
      respond = wakeNamed || c.respond;
      contextWindow = c.contextWindow;
    } else if (!config.addressingGate) {
      respond = true;
      contextWindow = config.contextWindowMax;
    }

    if (!respond) {
      // 谺宛でない発話: 黙って聞くだけ（履歴は残る）. 待機へ戻す.
      this.broadcast({ type: "status", text: "" });
      if (this.sm.state === AssistantState.LISTENING) {
        this.setState(AssistantState.IDLE);
      }
      return;
    }
    await this.respond(contextWindow);
  }

  private async respond(contextWindow = config.contextWindowDefault): Promise<void> {
    this.setState(AssistantState.THINKING);
    this.speakAborted = false;
    this.respondAbort = new AbortController();
    const sentencer = new Sentencer(config.ttsMinChars, config.ttsFirstMinChars);
    let assistantText = "";

    // 回答に使う履歴範囲をクランプして遡る（直近 win 件）.
    const win = Math.max(
      config.contextWindowMin,
      Math.min(config.contextWindowMax, contextWindow),
    );
    const history = this.history.slice(-win);

    // 応答生成は外部API・音声合成・ツール実行を含むため, どこで失敗しても
    // プロセスを落とさないよう全体を保護する（失敗時は待機へ戻して通知する）.
    try {
      const finalText = await this.claude.converse({
        history,
        toolContext: this.toolCtx,
        instructions: buildInstructions(this.persona) + this.behaviorSection(),
        signal: this.respondAbort.signal,
        onText: (delta) => {
          assistantText += delta;
          this.broadcast({ type: "assistant_delta", text: delta });
          for (const s of sentencer.push(delta)) this.speak(s);
        },
        onTool: (name) =>
          this.broadcast({ type: "status", text: TOOL_STATUS[name] ?? "処理中…" }),
      });

      const tail = sentencer.flush();
      if (tail) this.speak(tail);

      await this.speakChain; // 全文の再生完了まで待つ

      const text = (finalText || assistantText).trim();
      if (text) {
        const rec = this.store.addMessage({
          sessionId: this.sessionId,
          role: "assistant",
          text,
        });
        this.history.push(rec);
        this.broadcast({ type: "assistant_done", messageId: rec.id });
      }
    } catch (e) {
      console.log("[respond] 応答に失敗:", (e as Error).message);
      this.broadcast({
        type: "error",
        message: `応答に失敗しました: ${(e as Error).message}`,
      });
    } finally {
      this.broadcast({ type: "status", text: "" });
    }

    // 自己改修の適用・再起動（self_restart）: 読み上げの完了を待ってから実行する.
    // commitAndRestart は再開マーカーを永続化してから実ファイルへ書き込み,
    // プロセスを exit(87) で終える（監督プロセス/tsx watch が再起動する）.
    if (this.pendingRestartNote !== null && !this.speakAborted) {
      const note = this.pendingRestartNote;
      this.pendingRestartNote = null;
      this.broadcast({ type: "status", text: "自己改修を適用して再起動しています…" });
      this.selfmod.commitAndRestart(note, this.sessionId, this.store);
      return;
    }
    this.pendingRestartNote = null;

    // 割り込み（バージイン）で既に傾聴へ遷移している場合は何もしない.
    if (this.speakAborted) return;
    // 応答後は待機へ. 常時ストリーミングはIDLEでも聴取を続けるため, そのまま続けて話せる.
    this.localStt?.reset();
    this.streamPartial = "";
    if (this.streamingActive()) {
      this.setState(AssistantState.IDLE);
    } else if (config.followupListen && config.enableMic && this.input) {
      this.beginListening();
    } else {
      this.setState(AssistantState.IDLE);
    }
  }

  /**
   * DBの行動指針（自己知識）をシステムプロンプトへ差し込む節を組み立てる.
   * 鮮度（恒久=常に1, それ以外は半減期で減衰）で選別し,
   * 十分新しいもの（>=25%）はそのまま従う指針として,
   * 鮮度低下したもの（5〜25%）は「要再確認」として区別して渡す.
   * さらに古いもの（<5%）は注入しない（list_behaviors では見える）.
   */
  private behaviorSection(): string {
    const notes = this.store.listBehaviors();
    const fresh = notes.filter((n) => n.freshness >= 0.25).slice(0, 20);
    const fading = notes
      .filter((n) => n.freshness >= 0.05 && n.freshness < 0.25)
      .slice(0, 8);
    if (!fresh.length && !fading.length) return "";
    const line = (n: (typeof notes)[number]) =>
      `- [${n.id.slice(0, 8)}${n.permanent ? "・恒久" : `・鮮度${Math.round(n.freshness * 100)}%`}] ${n.content}`;
    let s =
      "\n\n【行動指針（自己知識DB）】\n" +
      "以下はあなた自身が learn_behavior で蓄えた, 振る舞いを制御する知識です．応答・行動はこれらを参照して行ってください．\n" +
      fresh.map(line).join("\n");
    if (fading.length) {
      s +=
        "\n次の指針は登録から時間が経ち鮮度が低下しています．盲目的に従わず, 関連する話題が出たら今も有効かさりげなく確認し, update_behavior で refresh（有効なら）または active=false（廃止なら）にしてください．\n" +
        fading.map(line).join("\n");
    }
    return s;
  }

  /** 1文を合成（即時開始）して順番に再生する */
  private speak(text: string): void {
    // マークダウン記号を落とし, 発音辞書で固有名詞の読みを整えてから合成する
    // （表示・履歴は原文のまま）.
    const plain = stripMarkdown(text).trim();
    if (!plain) return;
    const spoken = this.lexicon.apply(plain);
    const synth = this.tts
      .synthesize(spoken, {
        voice: this.persona.voice,
        instructions: this.persona.voiceInstructions,
      })
      .catch(() => null);

    this.speakChain = this.speakChain.then(async () => {
      const audio = await synth;
      if (!audio || this.speakAborted) return;
      if (this.sm.state !== AssistantState.SPEAKING) {
        this.setState(AssistantState.SPEAKING);
      }
      try {
        this.store.saveAudio(this.sessionId, "assistant", audio);
      } catch {
        /* 無視 */
      }
      await this.output.play(audio);
    });
  }

  private interrupt(): void {
    this.speakAborted = true;
    this.bargeCount = 0;
    this.respondAbort?.abort(); // 進行中の応答生成を即時中断する.
    this.localStt?.reset();
    this.output.stop();
    this.speakChain = Promise.resolve();
  }

  /** 発話中, フレーズに依らず一定以上の声が続いたらバージイン成立とみなす. */
  private detectEnergyBarge(frame: Buffer): boolean {
    const loud = frameRms(frame) >= this.micThreshold * config.bargeThresholdMult;
    if (!loud) {
      this.bargeCount = 0;
      return false;
    }
    if (++this.bargeCount >= config.bargeStartFrames) {
      this.bargeCount = 0;
      return true;
    }
    return false;
  }

  /** バージイン: 読み上げを止めて傾聴へ切り替え, 語頭を取りこぼさず常時STTへ引き継ぐ. */
  private bargeInterrupt(): void {
    this.interrupt();
    this.beginListening();
    if (this.streamingActive()) {
      // 直近フレーム（プリロール＋バージイン語頭）を流し込み, 頭の欠けを防ぐ.
      for (const f of this.recentFrames) this.localStt!.feed(f);
    }
    this.broadcast({ type: "status", text: "" });
  }

  // --- Web UIからのコマンド --------------------------------------------

  handleCommand(cmd: ClientCommand): void {
    switch (cmd.type) {
      case "text_input":
        if (
          this.sm.state === AssistantState.SPEAKING ||
          this.sm.state === AssistantState.THINKING
        ) {
          this.interrupt();
        }
        // テキスト入力は明示的な依頼: 応答ゲートを通さず必ず応答する.
        void this.handleUtterance(cmd.text, { explicit: true });
        break;
      case "interrupt":
        this.interrupt();
        this.setState(AssistantState.IDLE);
        break;
      case "wake":
        // 手動ウェイク: 直後の発話を明示依頼として扱う（谺宛判定を飛ばす）.
        // 発話・思考中でも割り込んで傾聴へ切り替える（ショートカット等からのカットイン）.
        if (
          this.sm.state === AssistantState.SPEAKING ||
          this.sm.state === AssistantState.THINKING
        ) {
          this.interrupt();
        }
        this.expectAddressed = true;
        this.beginListening();
        break;
      case "set_persona":
        this.persona = { ...this.persona, ...cmd.persona };
        this.store.setSetting("persona", this.persona);
        break;
      case "ui_event": {
        // 生成UI（フォーム等）からの操作を, 谺への明示入力として会話へ流す（§15.4）.
        if (
          this.sm.state === AssistantState.SPEAKING ||
          this.sm.state === AssistantState.THINKING
        ) {
          this.interrupt();
        }
        const label = cmd.name?.trim();
        const text = label ? `（画面操作）${label}: ${cmd.value}` : cmd.value;
        void this.handleUtterance(text, { explicit: true });
        break;
      }
      case "files_uploaded": {
        // アップロードエリア（request_file_upload）の結果を谺への明示入力として流す.
        if (
          this.sm.state === AssistantState.SPEAKING ||
          this.sm.state === AssistantState.THINKING
        ) {
          this.interrupt();
        }
        const text =
          cmd.canceled || cmd.files.length === 0
            ? "（ファイル受領）ユーザはアップロードせずにエリアを閉じました．"
            : "（ファイル受領）次のファイルを受け取りDBへ保存しました:\n" +
              cmd.files
                .map((f) => `- ${f.name}（${f.mimeType}, ${f.size}バイト, id: ${f.id}）`)
                .join("\n");
        void this.handleUtterance(text, { explicit: true });
        break;
      }
    }
  }

  getPersona(): PersonaConfig {
    return this.persona;
  }

  /**
   * WebSocket接続直後のクライアントへ現在状態のスナップショットを送る.
   * broadcast は変化時にしか流れないため, 接続前に確定していた状態
   * （在室・対話状態・ショートカット設定）をここで同期する.
   */
  sendSnapshot(send: (ev: ServerEvent) => void): void {
    send({ type: "state", state: this.sm.state });
    send({ type: "presence", present: this.present });
    send({ type: "shortcuts", shortcuts: this.getShortcuts() });
  }

  // --- 音声入出力デバイス（設定画面） ----------------------------------

  /** 利用可能な入出力デバイス一覧と現在の選択を返す. */
  async getAudioDevices(): Promise<AudioDevicesInfo> {
    const [input, output] = await Promise.all([
      listInputDevices(),
      listOutputDevices(),
    ]);
    return {
      input,
      output,
      selected: {
        inputIndex: this.inputIndex,
        outputIndex: this.output.deviceIndex,
      },
    };
  }

  /** マイク入力デバイスを切り替え, 取り込みを再起動して永続化する. */
  setInputDevice(index: number): void {
    this.inputIndex = index;
    if (config.enableMic) {
      this.stopMic();
      this.startMic();
    }
    this.persistDevices();
  }

  /** スピーカー出力デバイスを切り替えて永続化する（-1=システム既定）. */
  setOutputDevice(index: number): void {
    this.output.deviceIndex = index;
    this.persistDevices();
  }

  /**
   * 入力デバイスのテスト. 常駐マイクが動いていれば実ストリームから, そうでなければ
   * 単発録音で, 約1.5秒のあいだに拾えたピーク音量を測って返す.
   */
  testInputDevice(ms = 1500): Promise<AudioInputTest> {
    if (this.input) {
      this.inputProbe = { peak: 0 };
      return new Promise((resolve) => {
        setTimeout(() => {
          const peak = this.inputProbe?.peak ?? 0;
          this.inputProbe = null;
          resolve({ level: Math.min(1, peak), ok: peak >= 0.01 });
        }, ms);
      });
    }
    return captureInputLevel(this.inputIndex, config.sampleRate, ms);
  }

  /** 出力デバイスへテスト音を鳴らす. */
  async testOutputDevice(): Promise<{ ok: boolean }> {
    try {
      await playTestTone(this.output.deviceIndex);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  private persistDevices(): void {
    this.store.setSetting("audioDevices", {
      inputIndex: this.inputIndex,
      outputIndex: this.output.deviceIndex,
    });
  }

  // --- カメラ在室検知（設定画面） ---------------------------------------

  /** 現在のカメラ接続設定（設定画面で保存した値 > 環境変数の初期値）. */
  private cameraSettings(): CameraSettings {
    const saved = this.store.getSetting<Partial<CameraSettings>>("camera");
    return {
      rtspUrl: saved?.rtspUrl ?? config.cameraRtspUrl,
      host: saved?.host ?? config.cameraHost,
      user: saved?.user ?? config.cameraUser,
      pass: saved?.pass ?? config.cameraPass,
    };
  }

  /** 設定からRTSP URLを解決する（直接指定 > Qwatch APIで自動解決）. */
  private async resolveCameraUrl(s: CameraSettings): Promise<string> {
    if (s.rtspUrl) return s.rtspUrl;
    if (!s.host || !s.user) return "";
    const url = await new QwatchClient(s.host, s.user, s.pass).resolveRtspUrl();
    console.log(
      `[camera] Qwatch APIでRTSP URLを自動解決: ${url.replace(/\/\/[^@]*@/, "//****@")}`,
    );
    return url;
  }

  /** 現在の設定で在室検知を起動する（接続情報が無ければ何もしない）. */
  private async startCamera(): Promise<void> {
    let rtspUrl = "";
    try {
      rtspUrl = await this.resolveCameraUrl(this.cameraSettings());
    } catch (e) {
      console.log("[camera] RTSP URL自動解決に失敗:", (e as Error).message);
    }
    if (!rtspUrl) return;
    this.cameraUrl = rtspUrl;
    // 人物検出器は初回だけ初期化し, カメラ再起動（設定変更）をまたいで使い回す.
    if (!this.personDetector) {
      this.personDetector = new PersonDetector();
      await this.personDetector.init();
    }
    this.camera = new CameraPresence(
      rtspUrl,
      {
        pollMs: config.cameraPollMs,
        pixelDiff: config.presencePixelDiff,
        motionRatio: config.presenceMotionRatio,
        globalChangeRatio: config.presenceGlobalChangeRatio,
        holdMs: config.presenceHoldSec * 1000,
        detectIntervalMs: config.presenceDetectIntervalMs,
        personEnter: config.personScoreThreshold,
        personSustain: config.personScoreSustain,
      },
      this.personDetector,
    );
    this.camera.on("presence", (p: boolean) => {
      this.present = p;
      this.broadcast({ type: "presence", present: p });
    });
    let camErrLogged = false;
    this.camera.on("error", (e: Error) => {
      if (!camErrLogged) {
        camErrLogged = true;
        console.log(
          `[camera] RTSP未接続: ${e.message} — カメラ設定でRTSPを有効化してください`,
        );
      }
    });
    this.camera.start();
    console.log("[camera] 在室検知開始");
  }

  /** 在室検知を停止する（在室中だった場合はUIへ不在を通知）. */
  private stopCamera(): void {
    this.camera?.stop();
    this.camera = null;
    this.cameraUrl = "";
    if (this.present) {
      this.present = false;
      this.broadcast({ type: "presence", present: false });
    }
  }

  /** カメラ設定の現在値と稼働状態を返す. */
  getCameraInfo(): CameraInfo {
    return {
      settings: this.cameraSettings(),
      running: this.camera !== null,
      present: this.present,
    };
  }

  /** カメラ設定を保存し, 在室検知を新しい設定で再起動する. */
  async setCameraSettings(s: CameraSettings): Promise<CameraInfo> {
    this.store.setSetting("camera", s);
    this.stopCamera();
    await this.startCamera();
    return this.getCameraInfo();
  }

  /**
   * ライブプレビュー配信用のRTSP URLを返す. 在室検知の稼働中は解決済みURLを,
   * 未稼働なら現在の設定からその場で解決する（解決できなければ空文字）.
   */
  async getCameraPreviewUrl(): Promise<string> {
    if (this.cameraUrl) return this.cameraUrl;
    try {
      return await this.resolveCameraUrl(this.cameraSettings());
    } catch {
      return "";
    }
  }

  /** 指定された（未保存の）設定でカメラに接続し, 映像が取れるか確認する. */
  async testCamera(s: CameraSettings): Promise<CameraTestResult> {
    try {
      const url = await this.resolveCameraUrl(s);
      if (!url) {
        return {
          ok: false,
          message: "RTSP URL, またはホストとユーザ名を入力してください",
        };
      }
      await probeRtsp(url);
      return { ok: true, message: "カメラに接続し映像を取得できました" };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  // --- グローバルショートカット（設定画面・Electron） --------------------

  /** 現在のショートカット設定（未保存分は既定値で補完）. */
  getShortcuts(): ShortcutSettings {
    const saved = this.store.getSetting<Partial<ShortcutSettings>>("shortcuts");
    return {
      openSettings: saved?.openSettings?.trim() || DEFAULT_SHORTCUTS.openSettings,
      hearing: saved?.hearing?.trim() || DEFAULT_SHORTCUTS.hearing,
    };
  }

  /**
   * ショートカット設定を保存し, "shortcuts" イベントで配信する.
   * ElectronとWeb UIが受信して即時に再登録する（再起動不要のリアルタイム反映）.
   */
  setShortcuts(patch: Partial<ShortcutSettings>): ShortcutSettings {
    const cur = this.getShortcuts();
    const next: ShortcutSettings = {
      openSettings:
        patch.openSettings?.trim() || cur.openSettings,
      hearing: patch.hearing?.trim() || cur.hearing,
    };
    this.store.setSetting("shortcuts", next);
    this.broadcast({ type: "shortcuts", shortcuts: next });
    return next;
  }

  // --- 話者（声による個人識別, 設定画面での編集） ------------------------

  /** 登録済み話者の一覧（メタデータのみ）. */
  getSpeakers(): SpeakerRecord[] {
    return this.store.listSpeakers();
  }

  /** 話者の名前・読みを変更する（識別器が有効なら照合プロファイルも即時更新）. */
  renameSpeaker(oldName: string, newName: string, reading?: string | null): boolean {
    if (this.speakers) return this.speakers.rename(oldName, newName, reading);
    return this.store.renameSpeaker(oldName, newName, reading);
  }

  /** 話者の登録を削除する（声を忘れる）. */
  forgetSpeaker(name: string): boolean {
    if (this.speakers) return this.speakers.forget(name);
    return this.store.removeSpeaker(name);
  }

  // --- 発音辞書 --------------------------------------------------------

  getLexicon(): LexEntry[] {
    return this.lexicon.list();
  }

  addLexicon(surface: string, reading: string): LexEntry[] {
    this.lexicon.add(surface, reading);
    return this.lexicon.list();
  }

  removeLexicon(surface: string): boolean {
    return this.lexicon.remove(surface);
  }

  getHistory(): MessageRecord[] {
    return this.history;
  }

  // --- 語彙・トピック・横断検索（§15.1〜15.3, 設定UI/参照用） ------------

  getTerms() {
    return this.store.listTerms(false);
  }

  addTerm(input: {
    surface: string;
    reading?: string | null;
    kind?: string;
    aliases?: string[];
  }) {
    const rec = this.store.upsertTerm({ ...input, source: "user", weight: 1 });
    if (rec?.reading) this.lexicon?.add(rec.surface, rec.reading);
    return this.store.listTerms(false);
  }

  setTermActive(surface: string, active: boolean) {
    this.store.setTermActive(surface, active);
    return this.store.listTerms(false);
  }

  removeTerm(surface: string) {
    return this.store.removeTerm(surface);
  }

  getTopics(limit = 50) {
    return this.store.recentTopics(limit);
  }

  search(query: string) {
    return this.store.searchAll(query, { limit: 30 });
  }

  /** 行動指針の一覧（鮮度つき, 廃止済み含む．参照UI/API用） */
  getBehaviors() {
    return this.store.listBehaviors(true);
  }

  // --- ファイル（アップロード保管. 実体はDBにBLOB格納, /api/files） ------

  saveFile(input: { name: string; mimeType: string; data: Buffer }) {
    return this.store.saveFile(input);
  }

  getFile(id: string) {
    return this.store.getFile(id);
  }

  listFiles() {
    return this.store.listFiles();
  }

  deleteFile(id: string) {
    return this.store.deleteFile(id);
  }

  private setState(s: AssistantState): void {
    this.sm.transition(s);
  }

  async stop(): Promise<void> {
    this.clearListenTimer();
    this.stopMic();
    this.localStt?.stop();
    this.output.stop();
    this.camera?.stop();
    this.wake.release();
    this.digester?.stop();
    // セッション要約を生成して保存する（§15.2）. 失敗・遅延しても終了は妨げない.
    let summary: string | null = null;
    if (this.sessionId && this.history.length) {
      try {
        summary = await Promise.race([
          this.claude.summarizeSession(this.history),
          new Promise<null>((r) => setTimeout(() => r(null), 4000)),
        ]);
      } catch {
        /* 要約失敗は無視 */
      }
    }
    if (this.sessionId) this.store.endSession(this.sessionId, summary);
    // 終了時に未要約分をできる範囲で畳み込む（最終フラッシュ）.
    try {
      await this.digester?.digest();
    } catch {
      /* 無視 */
    }
  }
}
