import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

/**
 * ffmpeg を子プロセスとして起動し, マイクから 16kHz/mono/s16le のPCMを取り込む.
 * 固定長フレーム（既定512サンプル=1024バイト, Porcupine互換）に切り出して "frame" を発火.
 * ネイティブaddonに依存せず, ffmpeg バイナリのみで動く.
 */
export class FfmpegInput extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = Buffer.alloc(0);
  private readonly frameBytes: number;

  constructor(
    private device: string,
    private sampleRate: number,
    frameSamples: number,
  ) {
    super();
    this.frameBytes = frameSamples * 2;
  }

  start(): void {
    // macOS: avfoundation. 他OSでは alsa/dshow へ要変更.
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "avfoundation",
      "-i",
      this.device,
      "-ar",
      String(this.sampleRate),
      "-ac",
      "1",
      "-f",
      "s16le",
      "pipe:1",
    ];
    const proc = spawn("ffmpeg", args);
    this.proc = proc;

    proc.stdout.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      while (this.buf.length >= this.frameBytes) {
        const frame = this.buf.subarray(0, this.frameBytes);
        this.buf = this.buf.subarray(this.frameBytes);
        this.emit("frame", Buffer.from(frame));
      }
    });
    proc.stderr.on("data", (d: Buffer) =>
      this.emit("log", d.toString().trim()),
    );
    proc.on("error", (err) => this.emit("error", err));
    proc.on("close", (code) => this.emit("close", code));
  }

  stop(): void {
    this.proc?.kill("SIGKILL");
    this.proc = null;
  }
}
