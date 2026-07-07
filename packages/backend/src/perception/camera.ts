import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { PersonDetector } from "./personDetect.js";

/** CameraPresence の判定パラメータ */
export interface PresenceOptions {
  /** フレーム差分のポーリング間隔（ms） */
  pollMs: number;
  /** 「変化した」とみなす1画素あたりの輝度差（0〜255） */
  pixelDiff: number;
  /** 動きと判定する変化画素の割合（0〜1） */
  motionRatio: number;
  /** これ以上の割合が一斉に変化したら照明変化・露出調整とみなし動きに数えない（0〜1） */
  globalChangeRatio: number;
  /** 在室の保持時間（ms）. 最後の根拠（動き/人物検出）からこの時間で不在に落とす */
  holdMs: number;
  /** ONNX人物検出の実行間隔（ms）. 検出器が無効なら使われない */
  detectIntervalMs: number;
  /** 人物検出の「入り」スコア閾値（不在→在室） */
  personEnter: number;
  /** 人物検出の「維持」スコア閾値（在室中はこの弱い検出でも根拠になる）.
      頭だけが見切れている等のスコア低下で在室が途切れるのを防ぐ */
  personSustain: number;
}

/**
 * IPカメラ(RTSP)の在室検知（動き＋人物検出のハイブリッド）.
 *
 * [動き] ffmpegでRTSPから一定間隔で小さなグレースケールフレーム(64x64)を取り出し,
 * 「一定以上変化した画素の割合」で動きを判定する. 平均差分と違い, 画面の一部だけが
 * 動くタイピング等も拾え, 全画素が一斉に変わる照明変化・自動露出は動きに数えない.
 *
 * [人物検出] 静止している人は差分に現れないため, PersonDetector（ONNX, 任意）で
 * 定期的に「人が映っているか」を直接確認し, 在室の根拠を補強する.
 *
 * [判定] 在室 = 直近 holdMs 以内に根拠（動き or 人物検出）がある.
 * 根拠が途絶えたら holdMs 経過で不在へ. さらに人物検出が有効な場合,
 * 「動きが無く, 人物検出が2回連続で不在」なら holdMs を待たず早期に不在へ落とす.
 *
 * "presence" イベント(boolean)を在室状態の変化時に発火する.
 */
export class CameraPresence extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private prev: Buffer | null = null;
  private present = false;
  private readonly W = 64;
  private readonly H = 64;

  /** 最後に在室の根拠（動き/人物検出）を得た時刻（0=まだ無い） */
  private lastEvidenceAt = 0;
  /** 最後に動きを検知した時刻 */
  private lastMotionAt = 0;
  /** 人物検出の連続「不在」回数（早期不在判定に使う） */
  private noPersonStreak = 0;
  /** 人物検出の実行中フラグ（多重起動防止） */
  private detecting = false;
  private lastDetectAt = 0;

  constructor(
    private rtspUrl: string,
    private opts: PresenceOptions,
    private detector: PersonDetector | null = null,
  ) {
    super();
  }

  start(): void {
    if (!this.rtspUrl) return;
    this.timer = setInterval(() => this.tick(), this.opts.pollMs);
  }

  private tick(): void {
    this.grabGrayFrame();
    this.maybeDetectPerson();
    this.evaluate();
  }

  /** グレースケール小フレームを取り, 変化画素の割合から動きを判定する. */
  private grabGrayFrame(): void {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-rtsp_transport",
      "tcp",
      "-i",
      this.rtspUrl,
      "-frames:v",
      "1",
      "-vf",
      `scale=${this.W}:${this.H},format=gray`,
      "-f",
      "rawvideo",
      "pipe:1",
    ];
    const proc = spawn("ffmpeg", args);
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.on("error", (err) => this.emit("error", err));
    proc.on("close", (code) => {
      const frame = Buffer.concat(chunks);
      if (frame.length < this.W * this.H) {
        // フレームが取れない＝RTSP未接続等. 非ゼロ終了はエラーとして通知.
        if (code) this.emit("error", new Error(`RTSP取得失敗 (ffmpeg code=${code})`));
        return;
      }
      if (this.prev) {
        const len = this.W * this.H;
        let changed = 0;
        for (let i = 0; i < len; i++) {
          if (Math.abs((frame[i] ?? 0) - (this.prev[i] ?? 0)) >= this.opts.pixelDiff) {
            changed++;
          }
        }
        const ratio = changed / len;
        // 局所的な変化＝動き. 画面全体が一斉に変わる場合は照明変化とみなして無視する.
        if (ratio >= this.opts.motionRatio && ratio < this.opts.globalChangeRatio) {
          const now = Date.now();
          this.lastMotionAt = now;
          this.lastEvidenceAt = now;
          this.noPersonStreak = 0;
        }
      }
      this.prev = frame;
    });
  }

  /** 一定間隔でONNX人物検出を回し, 在室の根拠を補強する（無効時は何もしない）. */
  private maybeDetectPerson(): void {
    if (!this.detector?.available || this.detecting) return;
    const now = Date.now();
    if (now - this.lastDetectAt < this.opts.detectIntervalMs) return;
    this.lastDetectAt = now;
    this.detecting = true;
    void this.detector
      .detect(this.rtspUrl)
      .then((r) => {
        if (!r) return; // 判定不能は根拠に使わない
        // 二段閾値: 不在→在室は personEnter, 在室の維持は緩い personSustain で判定する.
        // 頭部だけしか映っていない等のスコア低下でも, 在室中なら根拠として継続する.
        const threshold = this.present
          ? this.opts.personSustain
          : this.opts.personEnter;
        if (r.score >= threshold) {
          this.lastEvidenceAt = Date.now();
          this.noPersonStreak = 0;
        } else {
          this.noPersonStreak++;
        }
      })
      .finally(() => {
        this.detecting = false;
        this.evaluate();
      });
  }

  /** 根拠の鮮度から在室状態を更新し, 変化時に "presence" を発火する. */
  private evaluate(): void {
    const now = Date.now();
    let nowPresent: boolean;
    if (!this.lastEvidenceAt) {
      nowPresent = false;
    } else if (
      // 早期不在: 人物検出が2回連続で「人なし」かつ検出間隔ぶん動きも無い.
      this.detector?.available &&
      this.noPersonStreak >= 2 &&
      now - this.lastMotionAt > this.opts.detectIntervalMs
    ) {
      nowPresent = false;
    } else {
      nowPresent = now - this.lastEvidenceAt < this.opts.holdMs;
    }
    if (nowPresent !== this.present) {
      this.present = nowPresent;
      this.emit("presence", nowPresent);
    }
  }

  isPresent(): boolean {
    return this.present;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * RTSPからMJPEG（multipart/x-mixed-replace）へ変換するffmpegを起動する
 * （設定画面のライブプレビュー用）. stdout をそのままHTTPレスポンスへ
 * パイプでき, ブラウザは <img src> だけで連続フレームを描画できる.
 * mpjpegマルチパートの境界文字列はffmpeg既定の "ffmpeg".
 */
export function spawnMjpegStream(
  rtspUrl: string,
  fps = 8,
  width = 640,
): ChildProcessWithoutNullStreams {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-rtsp_transport",
    "tcp",
    "-i",
    rtspUrl,
    "-an",
    "-vf",
    `fps=${fps},scale=${width}:-2`,
    "-q:v",
    "6",
    "-f",
    "mpjpeg",
    "pipe:1",
  ];
  return spawn("ffmpeg", args);
}

/**
 * RTSPへ接続して1フレーム取得できるかを確認する（設定画面の接続テスト用）.
 * 成功で resolve, 接続失敗・タイムアウトで理由つきの reject.
 */
export function probeRtsp(rtspUrl: string, timeoutMs = 10000): Promise<void> {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-rtsp_transport",
    "tcp",
    "-i",
    rtspUrl,
    "-frames:v",
    "1",
    "-f",
    "null",
    "-",
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let err = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("接続がタイムアウトしました（ホスト・ポートを確認してください）"));
    }, timeoutMs);
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        const lines = err.trim().split("\n").filter(Boolean);
        reject(new Error(lines[lines.length - 1] ?? `ffmpeg code=${code}`));
      }
    });
  });
}
