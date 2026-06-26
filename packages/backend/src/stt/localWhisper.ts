import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";

/**
 * ローカル Whisper（whisper.cpp CLI）による音声認識.
 * ffmpeg/ffplay と同様にバイナリを子プロセスとして起動し, ネイティブaddonに依存しない.
 * クラウドへ音声を送らずに文字起こしできるため, ウェイクワード照合に用いる.
 *
 * 必要なもの:
 *   - whisper.cpp の CLI（macOS: `brew install whisper-cpp` → `whisper-cli`）
 *   - ggml モデル（例: ggml-base.bin / ggml-small.bin）を WHISPER_MODEL に指定
 * いずれか欠けると available=false となり, 呼び出し側は手動ウェイクへフォールバックする.
 */
export class LocalWhisper {
  available = false;

  constructor(
    private bin: string = config.whisperBin,
    private model: string = config.whisperModel,
    private language: string = config.whisperLanguage,
  ) {}

  /** バイナリとモデルが揃っているか確認し, 使用可否を確定する. */
  async init(): Promise<boolean> {
    if (!this.model) {
      this.available = false;
      return false;
    }
    try {
      await access(this.model);
    } catch {
      this.available = false;
      return false;
    }
    this.available = await this.probe();
    return this.available;
  }

  private probe(): Promise<boolean> {
    return new Promise((resolve) => {
      const p = spawn(this.bin, ["--help"]);
      p.on("error", () => resolve(false));
      p.on("close", () => resolve(true));
    });
  }

  /** WAV(16kHz/mono/16bit) バッファを文字起こしする. */
  async transcribe(wav: Buffer): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "kodama-whisper-"));
    const wavPath = join(dir, "audio.wav");
    await writeFile(wavPath, wav);
    try {
      return await this.run(wavPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private run(wavPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        "-m",
        this.model,
        "-f",
        wavPath,
        "-l",
        this.language,
        "-nt", // タイムスタンプ無し（本文のみ）
        "-np", // 進捗・システム情報を抑止
      ];
      const p = spawn(this.bin, args);
      let out = "";
      let err = "";
      p.stdout.on("data", (d: Buffer) => (out += d.toString()));
      p.stderr.on("data", (d: Buffer) => (err += d.toString()));
      p.on("error", reject);
      p.on("close", (code) => {
        if (code === 0) resolve(out.trim());
        else reject(new Error(err.trim() || `whisper 異常終了 (code=${code})`));
      });
    });
  }
}
