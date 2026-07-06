/**
 * ストリーミングされるテキストデルタを「読み上げ単位」に切り出す.
 * 文末（「。．！？改行」）で区切るが, 短い文はまとめて一定長(minChars)以上の
 * チャンクにしてからTTSへ流す. これにより文ごとの細切れ再生による途切れを抑え,
 * なめらかに発話できる（最初のチャンクが出た瞬間に発話を始める投機的パイプラインは維持）.
 */
export class Sentencer {
  private buf = "";
  private emitted = false;
  private readonly boundary = /[。．！？!?\n]/g;

  /**
   * @param minChars このチャンク長に達する最初の文末で区切る（短文は結合）
   * @param firstMinChars 最初のチャンクだけに使う小さい閾値．最初の一文が出た
   *   瞬間に発話を始められるようにする（応答の大半が minChars 未満の短文でも,
   *   全文生成を待たずに話し始められる）
   */
  constructor(
    private minChars = 50,
    private firstMinChars = 6,
  ) {}

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];

    for (;;) {
      // 閾値以上になる最初の文末位置を探す（手前の短い文末は結合して読み流す）.
      // 最初のチャンクは firstMinChars で早めに切り出し, 発話の初動を速くする.
      const threshold = this.emitted ? this.minChars : this.firstMinChars;
      this.boundary.lastIndex = 0;
      let emitEnd = -1;
      let m: RegExpExecArray | null;
      while ((m = this.boundary.exec(this.buf)) !== null) {
        const end = m.index + 1;
        if (end >= threshold) {
          emitEnd = end;
          break;
        }
      }
      if (emitEnd === -1) break;
      const chunk = this.buf.slice(0, emitEnd).trim();
      this.buf = this.buf.slice(emitEnd);
      if (chunk) {
        out.push(chunk);
        this.emitted = true;
      }
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
