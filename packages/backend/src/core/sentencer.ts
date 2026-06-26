/**
 * ストリーミングされるテキストデルタを「読み上げ単位」に切り出す.
 * 文末（「。．！？改行」）で区切るが, 短い文はまとめて一定長(minChars)以上の
 * チャンクにしてからTTSへ流す. これにより文ごとの細切れ再生による途切れを抑え,
 * なめらかに発話できる（最初のチャンクが出た瞬間に発話を始める投機的パイプラインは維持）.
 */
export class Sentencer {
  private buf = "";
  private readonly boundary = /[。．！？!?\n]/g;

  /** @param minChars このチャンク長に達する最初の文末で区切る（短文は結合） */
  constructor(private minChars = 50) {}

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];

    for (;;) {
      // minChars 以上になる最初の文末位置を探す（手前の短い文末は結合して読み流す）.
      this.boundary.lastIndex = 0;
      let emitEnd = -1;
      let m: RegExpExecArray | null;
      while ((m = this.boundary.exec(this.buf)) !== null) {
        const end = m.index + 1;
        if (end >= this.minChars) {
          emitEnd = end;
          break;
        }
      }
      if (emitEnd === -1) break;
      const chunk = this.buf.slice(0, emitEnd).trim();
      this.buf = this.buf.slice(emitEnd);
      if (chunk) out.push(chunk);
    }
    return out;
  }

  /** 残りの未確定テキストを吐き出す */
  flush(): string {
    const rest = this.buf.trim();
    this.buf = "";
    return rest;
  }
}
