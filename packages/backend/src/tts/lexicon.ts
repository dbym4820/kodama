import type { Store } from "../memory/store.js";

/** 表層形→読み の1エントリ */
export interface LexEntry {
  surface: string;
  reading: string;
}

/** 初期辞書（ユーザー名の読み）. 必要に応じて追加・変更できる. */
const DEFAULT_ENTRIES: LexEntry[] = [
  { surface: "油谷知岐", reading: "あぶらたにともき" },
  { surface: "油谷", reading: "あぶらたに" },
  { surface: "知岐", reading: "ともき" },
];

/**
 * 発音辞書. 固有名詞などの読み誤りを防ぐため, TTSへ渡す直前に
 * 表層形を読み（かな）へ置換する. 内容は settings テーブルに永続化し,
 * 実行中に register_reading ツールや HTTP API から登録できる.
 */
export class Lexicon {
  private entries: LexEntry[] = [];

  constructor(
    private store: Store,
    private key = "lexicon",
  ) {}

  /** 永続化済みの辞書を読み込む. 無ければ初期辞書を保存して使う. */
  load(): void {
    const saved = this.store.getSetting<LexEntry[]>(this.key);
    if (saved && saved.length) {
      this.entries = saved;
    } else {
      this.entries = [...DEFAULT_ENTRIES];
      this.persist();
    }
  }

  private persist(): void {
    this.store.setSetting(this.key, this.entries);
  }

  list(): LexEntry[] {
    return [...this.entries];
  }

  /** 読みを登録（既存の表層形は上書き）する. */
  add(surface: string, reading: string): void {
    const s = surface.trim();
    const r = reading.trim();
    if (!s || !r) return;
    const existing = this.entries.find((e) => e.surface === s);
    if (existing) existing.reading = r;
    else this.entries.push({ surface: s, reading: r });
    this.persist();
  }

  remove(surface: string): boolean {
    const s = surface.trim();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.surface !== s);
    if (this.entries.length === before) return false;
    this.persist();
    return true;
  }

  /** TTS入力前に表層形を読みへ置換する（長い表層から順に適用）. */
  apply(text: string): string {
    let out = text;
    const sorted = [...this.entries].sort(
      (a, b) => b.surface.length - a.surface.length,
    );
    for (const e of sorted) {
      if (!e.surface) continue;
      out = out.split(e.surface).join(e.reading);
    }
    return out;
  }

  /**
   * STTの認識バイアス用ヒント（whisper系のpromptは「文脈例」なので,
   * 正しい表記の固有名詞を列挙して綴りを誘導する）.
   */
  sttHint(): string {
    if (!this.entries.length) return "";
    return `固有名詞: ${this.entries.map((e) => e.surface).join("，")}．`;
  }
}
