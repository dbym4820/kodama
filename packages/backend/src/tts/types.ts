/** 音声合成エンジン共通のインタフェース（OpenAI / ローカルを差し替え可能にする） */
export interface TtsSynthesizeOptions {
  voice?: string;
  instructions?: string;
  format?: "wav" | "mp3" | "opus";
}

export interface Tts {
  /** テキストを音声バッファ(WAV等)へ合成する */
  synthesize(text: string, opts?: TtsSynthesizeOptions): Promise<Buffer>;
}
