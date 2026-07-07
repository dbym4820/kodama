import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

/**
 * IPカメラ(RTSP)の在室検知.
 * ffmpegでRTSPから一定間隔で小さなグレースケールフレーム(32x32)を取り出し,
 * 直前フレームとの画素差分（平均絶対差）で動き＝在室を判定する.
 * ML推論なし・モデル不要で動くため, JS生態系の薄い視覚処理を回避する.
 * 精度を上げたい場合は §技術選定の通り ONNX 人物検出へ差し替え可能.
 *
 * "presence" イベント(boolean)を在室状態の変化時に発火する.
 */
export class CameraPresence extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private prev: Buffer | null = null;
  private present = false;
  private readonly W = 32;
  private readonly H = 32;

  constructor(
    private rtspUrl: string,
    private pollMs: number,
    private threshold: number,
  ) {
    super();
  }

  start(): void {
    if (!this.rtspUrl) return;
    this.timer = setInterval(() => this.tick(), this.pollMs);
  }

  private tick(): void {
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
        let diff = 0;
        const len = this.W * this.H;
        for (let i = 0; i < len; i++) {
          diff += Math.abs((frame[i] ?? 0) - (this.prev[i] ?? 0));
        }
        const avg = diff / len;
        const nowPresent = avg >= this.threshold;
        if (nowPresent !== this.present) {
          this.present = nowPresent;
          this.emit("presence", nowPresent);
        }
      }
      this.prev = frame;
    });
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
