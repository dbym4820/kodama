import { config } from "../config.js";
import { LocalWhisper } from "../stt/localWhisper.js";
import { SpeechSegmenter } from "../audio/vad.js";
import { pcmToWav } from "../audio/wav.js";

/**
 * ウェイクワード検知（ローカル Whisper）.
 * IDLE 中はエネルギーVADで発話区間を切り出し, ローカル Whisper（whisper.cpp）で
 * 文字起こしして, 設定された呼びかけフレーズ（既定は「こだま」＝谺/木霊等の同音表記）と照合する.
 * 音声をクラウドへ送らずに完結し, Picovoice のアクセスキーや .ppn を必要としない.
 *
 * Whisper のバイナリ／モデルが無い場合は available=false となり, システムは
 * 手動ウェイク（Web UIの「谺」ボタン等）にフォールバックする.
 */
export class WakeWord {
  available = false;
  private whisper = new LocalWhisper();
  private idleSeg: SpeechSegmenter;
  private speakSeg: SpeechSegmenter;
  private phrases: string[];
  private busy = false;
  private onDetect: () => void = () => {};
  private onTranscript: (text: string) => void = () => {};

  constructor() {
    // IDLE時: 通常のVAD閾値で呼びかけを切り出す.
    // 呼びかけは短いので発話上限フレームは控えめにし, 応答性を確保する.
    this.idleSeg = new SpeechSegmenter(
      config.vadThreshold,
      config.vadStartFrames,
      config.wakeSilenceFrames,
      config.wakeMaxFrames,
      config.vadPrerollFrames,
    );
    // SPEAKING時（割り込み）: アシスタント音声でエネルギーが高いため閾値を上げ,
    // それを上回るユーザーの割り込み発話だけを切り出して照合する.
    this.speakSeg = new SpeechSegmenter(
      config.vadThreshold * config.bargeThresholdMult,
      config.vadStartFrames,
      config.wakeSilenceFrames,
      config.wakeMaxFrames,
      config.vadPrerollFrames,
    );
    // ウェイクワードに加え, 発話中の中断フレーズ（「ストップ」等）も照合対象に含める.
    // どちらも発話中に聞き取れば読み上げを止める（onDetect→interrupt）.
    this.phrases = [...config.wakewordPhrases, ...config.stopPhrases]
      .map(normalize)
      .filter(Boolean);
  }

  /** ウェイクワード検知時のコールバックを登録する. */
  onDetected(cb: () => void): void {
    this.onDetect = cb;
  }

  /** 文字起こし結果（ライブ字幕用）を毎回受け取るコールバックを登録する. */
  onTranscribed(cb: (text: string) => void): void {
    this.onTranscript = cb;
  }

  async init(): Promise<boolean> {
    this.available = await this.whisper.init();
    return this.available;
  }

  /**
   * IDLE中のPCMフレームを投入. VADで発話を切り出し, 確定するたびに
   * ローカルWhisperで照合する（多重実行は busy で抑止）.
   */
  feed(frame: Buffer): void {
    this.consume(frame, this.idleSeg);
  }

  /**
   * SPEAKING中（アシスタント発話中）のPCMフレームを投入. 高い閾値で
   * ユーザーの割り込み発話だけを切り出し, 「こだま」等と一致すれば検知する.
   */
  feedDuringSpeech(frame: Buffer): void {
    this.consume(frame, this.speakSeg);
  }

  private consume(frame: Buffer, seg: SpeechSegmenter): void {
    if (!this.available) return;
    const { event, utterance } = seg.feed(frame);
    if (event === "end" && utterance && !this.busy) {
      this.busy = true;
      void this.detect(utterance).finally(() => {
        this.busy = false;
      });
    }
  }

  /** 状態遷移などで取りこぼしを避けるためVADを初期化する. */
  reset(): void {
    this.idleSeg.reset();
    this.speakSeg.reset();
  }

  /** マイク感度の実行時変更. 割り込み用は回り込み対策で高めに保つ. */
  setThreshold(threshold: number): void {
    this.idleSeg.setThreshold(threshold);
    this.speakSeg.setThreshold(threshold * config.bargeThresholdMult);
  }

  private async detect(pcm: Buffer): Promise<void> {
    let text: string;
    try {
      text = await this.whisper.transcribe(pcmToWav(pcm, config.sampleRate));
    } catch {
      return;
    }
    const clean = text.trim();
    // ライブ字幕として常時表示する（ウェイクワード照合とは独立に毎回通知）.
    if (clean) this.onTranscript(clean);
    const norm = normalize(clean);
    if (norm && this.phrases.some((p) => norm.includes(p))) {
      this.onDetect();
    }
  }

  release(): void {
    /* 永続リソースなし（whisperは都度起動） */
  }
}

/** 照合用の正規化: 小文字化し, 空白・記号を除去する. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s、。，．！？!?.,「」『』"'・]/g, "");
}
