import OpenAI from "openai";
import { config } from "../config.js";
import type { Tts, TtsSynthesizeOptions } from "./types.js";

/**
 * OpenAI 音声合成（gpt-4o-mini-tts）.
 * 局所的にOpenAIを使う箇所. Claudeが生成したテキストを音声化する.
 */
export class OpenAITts implements Tts {
  private client: OpenAI;

  constructor(apiKey: string = config.openaiApiKey) {
    this.client = new OpenAI({ apiKey });
  }

  /**
   * テキストを音声バッファに合成する.
   * Phase 1 では文単位で呼び出し, 逐次再生してレイテンシを隠す.
   */
  async synthesize(
    text: string,
    opts: TtsSynthesizeOptions = {},
  ): Promise<Buffer> {
    const res = await this.client.audio.speech.create({
      model: config.ttsModel,
      voice: opts.voice ?? config.ttsVoice,
      input: text,
      instructions: opts.instructions ?? "落ち着いた，簡潔で知的なトーンで読み上げてください．",
      response_format: opts.format ?? "wav",
    });
    return Buffer.from(await res.arrayBuffer());
  }
}
