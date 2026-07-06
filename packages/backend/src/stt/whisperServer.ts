import { spawn, execSync, type ChildProcess } from "node:child_process";
import { config } from "../config.js";

/**
 * whisper.cpp の `whisper-server` を常駐プロセスとして起動し, HTTP でバッファを
 * 文字起こしするラッパ. `whisper-cli` と違いモデルをメモリに常駐させ続けるため,
 * 数百msごとの繰り返し推論（擬似ストリーミングの途中表示）でもモデル再ロードが
 * 発生せず高速. 音声はクラウドへ送らず完結する.
 *
 * 起動: whisper-server -m <model> --host 127.0.0.1 --port <port> -l ja -nt
 * 推論: POST /inference  (multipart: file=<wav>, response_format=json) → { text }
 */
export class WhisperServer {
  private proc: ChildProcess | null = null;
  private ready = false;
  private readonly base: string;

  constructor(
    private model: string,
    private port: number,
    private opts: { language?: string; threads?: number; prompt?: string } = {},
  ) {
    this.base = `http://127.0.0.1:${port}`;
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** サーバを起動し, 推論可能になるまで待つ. */
  async start(): Promise<void> {
    // 再起動などで前回のサーバがポートに残っていると bind に失敗するため, 先に解放する.
    this.freePort();
    const args = [
      "-m", this.model,
      "--host", "127.0.0.1",
      "--port", String(this.port),
      "-l", this.opts.language ?? "ja",
      "-nt", // タイムスタンプ無し（本文のみ）
      "-sns", // 無音/非音声トークンを抑制（常時聴取での hallucination 低減）
      "-t", String(this.opts.threads ?? 4),
    ];
    if (this.opts.prompt) args.push("--prompt", this.opts.prompt);

    this.proc = spawn(config.whisperServerBin, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.proc.on("error", (e) =>
      console.log(`[whisper-server:${this.port}] 起動失敗:`, e.message),
    );
    this.proc.on("exit", (code) => {
      this.ready = false;
      this.proc = null;
      if (code && code !== 0) {
        console.log(`[whisper-server:${this.port}] 終了 (code=${code})`);
      }
    });

    await this.waitReady();
  }

  /** モデルロード完了（HTTP応答）までポーリングする. */
  private async waitReady(timeoutMs = 60000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!this.proc) throw new Error("whisper-server が起動しませんでした");
      try {
        // ルートにアクセスし, 何らかのHTTP応答が返れば起動済みとみなす.
        await fetch(this.base + "/", { method: "GET" });
        this.ready = true;
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    throw new Error(`whisper-server:${this.port} の起動待ちがタイムアウトしました`);
  }

  /**
   * WAV(16kHz/mono/16bit) を文字起こしする.
   * prompt はリクエスト毎の認識バイアス（固有名詞ヒント等）. whisper.cpp の
   * `/inference` は per-request の prompt を受け付けるため, サーバ再起動なしで
   * 語彙ヒントを動的に差し込める（§15.1）.
   */
  async transcribe(wav: Buffer, prompt?: string): Promise<string> {
    if (!this.ready) return "";
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(wav)], { type: "audio/wav" }),
      "audio.wav",
    );
    form.append("response_format", "json");
    const hint = prompt ?? this.opts.prompt;
    if (hint) form.append("prompt", hint);
    const res = await fetch(this.base + "/inference", {
      method: "POST",
      body: form,
    });
    if (!res.ok) throw new Error(`whisper-server ${res.status}`);
    const data = (await res.json()) as { text?: string };
    return (data.text ?? "").trim();
  }

  stop(): void {
    this.ready = false;
    this.proc?.kill("SIGTERM");
    this.proc = null;
  }

  /** ポートに残った前回の whisper-server を best-effort で終了させる. */
  private freePort(): void {
    try {
      const pids = execSync(`lsof -ti tcp:${this.port} 2>/dev/null || true`)
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean);
      for (const pid of pids) {
        try {
          execSync(`kill -9 ${pid} 2>/dev/null || true`);
        } catch {
          /* 無視 */
        }
      }
    } catch {
      /* lsof 不在等は無視 */
    }
  }
}
