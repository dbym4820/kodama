import OpenAI from "openai";
import { toFile } from "openai/uploads";
import { config } from "../config.js";

/**
 * OpenAI 音声認識（gpt-4o-transcribe）.
 * Phase 0 はバッファ単位の確定文字起こし（疎通確認・短発話用）.
 * Phase 1 でリアルタイムのストリーミング文字起こしに拡張する.
 */
export class OpenAIStt {
  private client: OpenAI;

  constructor(apiKey: string = config.openaiApiKey) {
    this.client = new OpenAI({ apiKey });
  }

  async transcribe(
    audio: Buffer,
    opts: { filename?: string; language?: string; prompt?: string } = {},
  ): Promise<string> {
    const file = await toFile(audio, opts.filename ?? "audio.wav");
    const res = await this.client.audio.transcriptions.create({
      file,
      model: config.sttModel,
      language: opts.language ?? "ja",
      // 固有名詞（ユーザー名など）の認識を補助するヒント.
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
    });
    return res.text;
  }
}
