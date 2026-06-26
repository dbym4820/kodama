import {
  AssistantState,
  type AudioDevicesInfo,
  type AudioInputTest,
  type ClientCommand,
  type MessageRecord,
  type PersonaConfig,
  type ServerEvent,
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
import { OpenAIStt } from "../stt/openaiStt.js";
import { LocalStreamingStt } from "../stt/localStreamingStt.js";
import { OpenAITts } from "../tts/openaiTts.js";
import type { Tts } from "../tts/types.js";
import { Lexicon, type LexEntry } from "../tts/lexicon.js";
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
import { CameraPresence } from "../perception/camera.js";
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
  search_papers: "文献を検索中…",
  read_paper: "文献を読み込み中…",
  web_search: "Web検索中…",
  notion_search: "Notionを検索中…",
  notion_get_page: "Notionページを読み込み中…",
  notion_append: "Notionに追記中…",
  notion_create_page: "Notionページを作成中…",
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

  private input: FfmpegInput | null = null;
  private output = new FfmpegOutput();
  private wake = new WakeWord();
  private lexicon!: Lexicon;
  private camera: CameraPresence | null = null;
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
    };
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

    // カメラ在室検知（URL未指定でも host+認証があればQwatch APIで自動解決）
    let rtspUrl = config.cameraRtspUrl;
    if (!rtspUrl && config.cameraHost && config.cameraUser) {
      try {
        rtspUrl = await new QwatchClient(
          config.cameraHost,
          config.cameraUser,
          config.cameraPass,
        ).resolveRtspUrl();
        console.log(
          `[camera] Qwatch APIでRTSP URLを自動解決: ${rtspUrl.replace(/\/\/[^@]*@/, "//****@")}`,
        );
      } catch (e) {
        console.log("[camera] RTSP URL自動解決に失敗:", (e as Error).message);
      }
    }
    if (rtspUrl) {
      this.camera = new CameraPresence(
        rtspUrl,
        config.cameraPollMs,
        config.presenceThreshold,
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

    // 常時聞き取り: 履歴に残しつつ, 谺へ向けられた発話だけに応答する.
    await this.handleUtterance(clean, { audioPath });
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
      // 日本語コンテキスト＋固有名詞でSTTを誘導（短い発話の他言語誤認識を防ぐ）.
      const prompt = `${config.sttPrompt}${this.lexicon.sttHint()}`;
      const text = await this.stt.transcribe(wav, { prompt });
      // フォールバック経路はウェイクワード起動後なので明示依頼として扱う.
      await this.handleUtterance(text, { audioPath, explicit: true });
    } catch (e) {
      this.broadcast({ type: "error", message: `STT失敗: ${(e as Error).message}` });
      this.setState(AssistantState.IDLE);
    }
  }

  // --- 会話処理 --------------------------------------------------------

  /** 発話を必ず履歴へ記録する（応答の有無に関わらず常に残す）. */
  private recordUtterance(text: string, audioPath: string | null = null) {
    const rec = this.store.addMessage({
      sessionId: this.sessionId,
      role: "user",
      text,
      audioPath,
    });
    this.history.push(rec);
    this.broadcast({ type: "transcript", final: true, text });
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
    opts: { audioPath?: string | null; explicit?: boolean } = {},
  ): Promise<void> {
    const clean = text.trim();
    if (!clean) {
      if (this.sm.state === AssistantState.LISTENING) {
        this.setState(AssistantState.IDLE);
      }
      return;
    }
    // どんな発話も履歴に残す.
    this.recordUtterance(clean, opts.audioPath ?? null);

    const explicit = opts.explicit || this.expectAddressed;
    this.expectAddressed = false;
    const wakeNamed = this.hasWakeName(clean);

    let contextWindow = config.contextWindowDefault;
    let respond = explicit || wakeNamed;

    if (config.addressingGate && !explicit) {
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
    const sentencer = new Sentencer(config.ttsMinChars);
    let assistantText = "";

    // 回答に使う履歴範囲をクランプして遡る（直近 win 件）.
    const win = Math.max(
      config.contextWindowMin,
      Math.min(config.contextWindowMax, contextWindow),
    );
    const history = this.history.slice(-win);

    const finalText = await this.claude.converse({
      history,
      toolContext: this.toolCtx,
      instructions: buildInstructions(this.persona),
      signal: this.respondAbort.signal,
      onText: (delta) => {
        assistantText += delta;
        this.broadcast({ type: "assistant_delta", text: delta });
        for (const s of sentencer.push(delta)) this.speak(s);
      },
      onTool: (name) => this.broadcast({ type: "status", text: TOOL_STATUS[name] ?? "処理中…" }),
    });

    const tail = sentencer.flush();
    if (tail) this.speak(tail);

    await this.speakChain; // 全文の再生完了まで待つ

    const rec = this.store.addMessage({
      sessionId: this.sessionId,
      role: "assistant",
      text: finalText || assistantText,
    });
    this.history.push(rec);
    this.broadcast({ type: "assistant_done", messageId: rec.id });
    this.broadcast({ type: "status", text: "" });
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

  /** 1文を合成（即時開始）して順番に再生する */
  private speak(text: string): void {
    // 発音辞書で固有名詞の読みを整えてから合成する（表示・履歴は原文のまま）.
    const spoken = this.lexicon.apply(text);
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
        this.expectAddressed = true;
        this.beginListening();
        break;
      case "set_persona":
        this.persona = { ...this.persona, ...cmd.persona };
        this.store.setSetting("persona", this.persona);
        break;
    }
  }

  getPersona(): PersonaConfig {
    return this.persona;
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

  private setState(s: AssistantState): void {
    this.sm.transition(s);
  }

  stop(): void {
    this.clearListenTimer();
    this.stopMic();
    this.localStt?.stop();
    this.output.stop();
    this.camera?.stop();
    this.wake.release();
    if (this.sessionId) this.store.endSession(this.sessionId);
  }
}
