/** s16le フレームの RMS（0〜1正規化） */
export function frameRms(frame: Buffer): number {
  const n = Math.floor(frame.length / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = frame.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

export type SegmentEvent = "start" | "end" | null;

/**
 * エネルギーベースの発話区間検出.
 * RMSが閾値を一定フレーム超えたら発話開始, 一定フレーム無音が続いたら終了とみなす.
 * 終了時に蓄積したPCMバッファを返す. （Phase 3でSilero VADへ差し替え可能）
 */
export class SpeechSegmenter {
  private active = false;
  private aboveCount = 0;
  private silenceCount = 0;
  private frames: Buffer[] = [];
  private totalFrames = 0;
  private preroll: Buffer[] = [];

  constructor(
    private threshold: number,
    private startFrames: number,
    private silenceFrames: number,
    private maxFrames: number,
    /** 発話開始前の直近フレームを何枚さかのぼって含めるか（語頭の欠けを防ぐ） */
    private prerollFrames = 0,
  ) {}

  reset(): void {
    this.active = false;
    this.aboveCount = 0;
    this.silenceCount = 0;
    this.frames = [];
    this.totalFrames = 0;
    this.preroll = [];
  }

  /** マイク感度の実行時変更用に発話判定のRMS閾値を更新する. */
  setThreshold(threshold: number): void {
    this.threshold = threshold;
  }

  /** フレームを投入. 状態イベントと, 終了時は確定PCMを返す */
  feed(frame: Buffer): { event: SegmentEvent; utterance?: Buffer } {
    const loud = frameRms(frame) >= this.threshold;

    if (!this.active) {
      // 発話開始前も直近フレームを保持し, 立ち上がりの語頭を取りこぼさない.
      if (this.prerollFrames > 0) {
        this.preroll.push(frame);
        if (this.preroll.length > this.prerollFrames) this.preroll.shift();
      }
      if (loud) {
        this.aboveCount++;
        if (this.aboveCount >= this.startFrames) {
          this.active = true;
          this.silenceCount = 0;
          // プリロール（現フレーム含む）を語頭として取り込む.
          this.frames = this.prerollFrames > 0 ? [...this.preroll] : [frame];
          this.totalFrames = this.frames.length;
          this.preroll = [];
          return { event: "start" };
        }
      } else {
        this.aboveCount = 0;
      }
      return { event: null };
    }

    // active
    this.frames.push(frame);
    this.totalFrames++;
    this.silenceCount = loud ? 0 : this.silenceCount + 1;

    if (
      this.silenceCount >= this.silenceFrames ||
      this.totalFrames >= this.maxFrames
    ) {
      const utterance = Buffer.concat(this.frames);
      this.reset();
      return { event: "end", utterance };
    }
    return { event: null };
  }
}
