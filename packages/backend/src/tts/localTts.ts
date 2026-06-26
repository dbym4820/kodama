import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";
import type { Tts, TtsSynthesizeOptions } from "./types.js";

/**
 * ローカル音声合成（macOS の `say` コマンド）.
 * ffmpeg/whisper と同様にバイナリを子プロセスとして起動し, クラウドへ送らず
 * 日本語音声（既定 Kyoko）でWAVを生成する. 速度は再生側(ffplay atempo)で調整する.
 */
export class LocalTts implements Tts {
  constructor(
    private voice: string = config.ttsSayVoice,
    private sampleRate = 24000,
  ) {}

  async synthesize(
    text: string,
    opts: TtsSynthesizeOptions = {},
  ): Promise<Buffer> {
    if (!text.trim()) return Buffer.alloc(0);
    const dir = await mkdtemp(join(tmpdir(), "kodama-say-"));
    const out = join(dir, "tts.wav");
    try {
      await this.run(text, out, opts.voice);
      return await readFile(out);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private run(text: string, outPath: string, voice?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        "-v",
        voice ?? this.voice,
        "-o",
        outPath,
        `--data-format=LEI16@${this.sampleRate}`,
        text,
      ];
      const p = spawn("say", args);
      let err = "";
      p.stderr.on("data", (d: Buffer) => (err += d.toString()));
      p.on("error", reject);
      p.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(err.trim() || `say 異常終了 (code=${code})`));
      });
    });
  }
}
