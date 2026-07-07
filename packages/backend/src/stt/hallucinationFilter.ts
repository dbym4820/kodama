import type { Store } from "../memory/store.js";

/**
 * 既知ハルシネーション（幻覚）フレーズの初期リスト.
 * Whisper系モデルはYouTube動画＋字幕で学習されているため, 無音・雑音区間を
 * 「動画の締めの挨拶」や「字幕クレジット」として誤って文字起こしすることが
 * 広く知られている（無音≒動画の終わり, と学習されてしまっている）.
 * ここに載せたフレーズは発話全体がこれと一致した場合のみ破棄されるので,
 * 文中に同じ語が含まれる通常の発話には影響しない.
 */
const DEFAULT_ENTRIES: string[] = [
  // 日本語: 動画の締め挨拶系（無音区間で最頻出）
  "ご視聴ありがとうございました",
  "ご視聴ありがとうございます",
  "最後までご視聴ありがとうございました",
  "ご清聴ありがとうございました",
  "ありがとうございました",
  "チャンネル登録お願いします",
  "チャンネル登録よろしくお願いします",
  "チャンネル登録と高評価をお願いします",
  "おやすみなさい",
  "お疲れ様でした",
  // 英語: 締め挨拶・字幕クレジット系
  "Thank you for watching",
  "Thanks for watching",
  "Please subscribe",
  "Please subscribe to my channel",
  "Transcribed by https://otter.ai",
  "Subtitles by the Amara.org community",
];

/** 比較用に句読点・記号・空白を除去して小文字化する（Qiita等で定石の判定法）. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s　。、．，,.!！?？…・~〜ー*「」『』()（）\[\]♪]/g, "");
}

/**
 * STT除外辞書（ハルシネーションフィルタ）.
 * ローカルWhisperが無音・雑音から生成する既知の幻覚フレーズを,
 * 会話へ渡す前に破棄する. 判定は「正規化後の全文一致」を基本とし,
 * 同一フレーズの連続繰り返し（「ご視聴〜。ご視聴〜。」）も幻覚とみなす.
 * 内容は settings テーブルに永続化し, HTTP API から編集できる.
 */
export class HallucinationFilter {
  private entries: string[] = [];
  private normalized = new Set<string>();

  constructor(
    private store: Store,
    private key = "hallucinationBlacklist",
  ) {}

  /** 永続化済みのリストを読み込む. 無ければ初期リストを保存して使う. */
  load(): void {
    const saved = this.store.getSetting<string[]>(this.key);
    if (saved && saved.length) {
      this.entries = saved;
    } else {
      this.entries = [...DEFAULT_ENTRIES];
      this.persist();
    }
    this.rebuild();
  }

  private persist(): void {
    this.store.setSetting(this.key, this.entries);
  }

  private rebuild(): void {
    this.normalized = new Set(
      this.entries.map(normalize).filter((e) => e.length > 0),
    );
  }

  list(): string[] {
    return [...this.entries];
  }

  add(phrase: string): void {
    const p = phrase.trim();
    if (!p || this.entries.some((e) => e === p)) return;
    this.entries.push(p);
    this.persist();
    this.rebuild();
  }

  remove(phrase: string): boolean {
    const p = phrase.trim();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e !== p);
    if (this.entries.length === before) return false;
    this.persist();
    this.rebuild();
    return true;
  }

  /**
   * 文字起こし結果が既知ハルシネーションかを判定する.
   * 文区切りごとに正規化して比較し, すべての文が登録フレーズに一致する
   * 場合のみ true（実発話に幻覚が混ざったケースを誤って落とさないため）.
   */
  isHallucination(text: string): boolean {
    const whole = normalize(text);
    if (!whole) return false;
    const segments = text
      .split(/[。．.!！?？\n]+/)
      .map(normalize)
      .filter((s) => s.length > 0);
    if (segments.length && segments.every((s) => this.matches(s))) return true;
    // 句読点なしで連結された繰り返し（「ご視聴〜ご視聴〜」）も幻覚とみなす.
    return this.matches(whole);
  }

  /** 正規化済み文字列が, 登録フレーズまたはその単純繰り返しに一致するか. */
  private matches(norm: string): boolean {
    if (this.normalized.has(norm)) return true;
    for (const e of this.normalized) {
      if (
        norm.length > e.length &&
        norm.length % e.length === 0 &&
        e.repeat(norm.length / e.length) === norm
      ) {
        return true;
      }
    }
    return false;
  }
}
