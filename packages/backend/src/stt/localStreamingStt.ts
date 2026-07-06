import { EventEmitter } from "node:events";
import { config } from "../config.js";
import { SpeechSegmenter } from "../audio/vad.js";
import { pcmToWav } from "../audio/wav.js";
import { WhisperServer } from "./whisperServer.js";

/**
 * 完全ローカルの常時ストリーミングSTT（whisper.cpp / whisper-server）.
 *
 * マイクフレームをエネルギーVADで発話区間に区切り, 発話中は一定間隔で「ここまでの音声」を
 * 高速モデル（partial）で再デコードして途中経過を配信する（＝話しながら文字が伸びる擬似
 * ストリーミング）. 無音で発話が終わると最高精度モデル（final）で確定し, それを会話の
 * 起点にする. クラウドへ音声を送らず, ウェイクワード不要で常時動作する.
 *
 * 日本語には真のtoken逐次ストリーミングのローカルモデルが存在しないため, 発話単位の
 * 確定＋途中再デコードでリアルタイム感を出す構成としている.
 *
 * イベント:
 *   - "ready"               2つの whisper-server が起動完了
 *   - "speechStarted"       発話開始（VAD）
 *   - "partial" (text)      途中経過の文字起こし（確定前・累積テキスト）
 *   - "final" (text, pcm)   発話確定（最高精度）. pcm は当該発話のPCM（履歴保存用）
 */
export class LocalStreamingStt extends EventEmitter {
  private finalServer: WhisperServer;
  private partialServer: WhisperServer;
  private sameModel: boolean;
  private ready = false;

  private seg: SpeechSegmenter;
  private active = false;
  private frames: Buffer[] = [];
  private partialBusy = false;
  private lastPartialAt = 0;
  private prompt: string;
  /** 認識バイアス用ヒントを動的に供給する（語彙更新を即反映, §15.1）. */
  private hintProvider: (() => string) | null = null;

  constructor(prompt = "") {
    super();
    this.prompt = prompt;
    this.sameModel = config.whisperPartialModel === config.whisperFinalModel;
    this.finalServer = new WhisperServer(
      config.whisperFinalModel,
      config.whisperServerPortFinal,
      { language: "ja", threads: config.whisperServerThreads, prompt },
    );
    this.partialServer = this.sameModel
      ? this.finalServer
      : new WhisperServer(config.whisperPartialModel, config.whisperServerPortPartial, {
          language: "ja",
          threads: config.whisperServerThreads,
          prompt,
        });
    // 発話区間検出（語頭プリロール付き）. 終端の無音は応答性重視で短め.
    this.seg = new SpeechSegmenter(
      config.vadThreshold,
      config.vadStartFrames,
      config.vadSilenceFrames,
      config.vadMaxFrames,
      config.vadPrerollFrames,
    );
  }

  get isReady(): boolean {
    return this.ready;
  }

  setThreshold(threshold: number): void {
    this.seg.setThreshold(threshold);
  }

  /** 認識ヒント（固有名詞・専門語の列挙）を供給するプロバイダを設定する. */
  setHintProvider(fn: () => string): void {
    this.hintProvider = fn;
  }

  /** 現在の認識ヒント（起動時prompt＋動的な語彙ヒント）を組み立てる. */
  private currentHint(): string {
    const dynamic = this.hintProvider?.() ?? "";
    return [this.prompt, dynamic].filter(Boolean).join(" ");
  }

  /** whisper-server を起動する（モデルロードに数秒かかる）. */
  async start(): Promise<void> {
    await this.finalServer.start();
    if (!this.sameModel) await this.partialServer.start();
    this.ready = true;
    this.emit("ready");
  }

  /** 発話区間検出をリセットする（傾聴開始・状態遷移時の取りこぼし防止）. */
  reset(): void {
    this.seg.reset();
    this.active = false;
    this.frames = [];
    this.partialBusy = false;
  }

  /** マイクフレーム（16kHz/mono/s16le）を投入する. */
  feed(frame: Buffer): void {
    if (!this.ready) return;
    const { event, utterance } = this.seg.feed(frame);

    if (event === "start") {
      this.active = true;
      this.frames = [frame];
      this.lastPartialAt = Date.now();
      this.emit("speechStarted");
      return;
    }

    if (event === "end" && utterance) {
      this.active = false;
      this.frames = [];
      void this.finalize(utterance);
      return;
    }

    if (this.active) {
      this.frames.push(frame);
      this.maybePartial();
    }
  }

  /** 発話中, 一定間隔で「ここまで」を高速モデルで再デコードして途中経過を出す. */
  private maybePartial(): void {
    if (this.partialBusy) return;
    if (Date.now() - this.lastPartialAt < config.partialIntervalMs) return;
    this.lastPartialAt = Date.now();
    this.partialBusy = true;
    const wav = pcmToWav(Buffer.concat(this.frames), config.sampleRate);
    this.partialServer
      .transcribe(wav, this.currentHint())
      .then((text) => {
        if (text && this.active) this.emit("partial", text);
      })
      .catch(() => {})
      .finally(() => {
        this.partialBusy = false;
      });
  }

  /** 発話確定. 最高精度モデルで文字起こしして "final" を発火する. */
  private async finalize(pcm: Buffer): Promise<void> {
    const wav = pcmToWav(pcm, config.sampleRate);
    let text = "";
    try {
      text = await this.finalServer.transcribe(wav, this.currentHint());
    } catch (e) {
      console.log("[local-stt] final 文字起こし失敗:", (e as Error).message);
    }
    this.emit("final", text, pcm);
  }

  stop(): void {
    this.ready = false;
    this.finalServer.stop();
    if (!this.sameModel) this.partialServer.stop();
  }
}
