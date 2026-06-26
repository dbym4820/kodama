import { spawn, type ChildProcess } from "node:child_process";
import { config } from "../config.js";

/**
 * atempoは1段あたり0.5〜2.0倍までなので, 任意倍率を複数段に分解する.
 * 例: 3.0 → "atempo=2.0,atempo=1.5". 音程は保ったまま速度のみ変える.
 */
function atempoChain(speed: number): string[] {
  if (!(speed > 0) || Math.abs(speed - 1) < 1e-3) return [];
  let f = speed;
  const parts: string[] = [];
  while (f > 2.0) {
    parts.push("atempo=2.0");
    f /= 2.0;
  }
  while (f < 0.5) {
    parts.push("atempo=0.5");
    f /= 0.5;
  }
  parts.push(`atempo=${f.toFixed(4)}`);
  return ["-af", parts.join(",")];
}

/**
 * ffmpeg を子プロセスとして起動し, WAV/音声バッファを順番に再生する.
 * 出力は CoreAudio(audiotoolbox) へ流し, deviceIndex で再生先スピーカーを選べる.
 * 文単位の音声を逐次キューに積み, 順序を保って再生（投機的パイプラインの再生側）.
 * stop() で再生中プロセスを即停止し, バージインに対応する.
 */
export class FfmpegOutput {
  private current: ChildProcess | null = null;
  /** 再生速度（実行時に変更可能）. 既定は設定値. */
  speed = config.ttsSpeed;
  /** 出力デバイスのCoreAudioインデックス（-1=システム既定）. 実行時に変更可能. */
  deviceIndex = -1;

  /** 1バッファを再生（完了でresolve）. 停止された場合もresolveする. */
  play(audio: Buffer): Promise<void> {
    return new Promise((resolve) => {
      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        ...atempoChain(this.speed),
        "-f",
        "audiotoolbox",
      ];
      if (this.deviceIndex >= 0) {
        args.push("-audio_device_index", String(this.deviceIndex));
      }
      args.push("-");
      const proc = spawn("ffmpeg", args);
      this.current = proc;

      proc.on("close", () => {
        if (this.current === proc) this.current = null;
        resolve();
      });
      proc.on("error", () => {
        if (this.current === proc) this.current = null;
        resolve();
      });

      proc.stdin.on("error", () => {
        /* stop()でkillした際のEPIPEを無視 */
      });
      proc.stdin.write(audio);
      proc.stdin.end();
    });
  }

  /** 現在の再生を即停止 */
  stop(): void {
    this.current?.kill("SIGKILL");
    this.current = null;
  }
}
