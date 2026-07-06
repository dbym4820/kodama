import { config } from "../config.js";
import type { Store } from "../memory/store.js";
import type { SpeakerRecord } from "@kodama/shared";

/**
 * 話者識別（声による個人識別）.
 *
 * 発話確定時のPCM（16kHz/mono/s16le）から sherpa-onnx の話者埋め込みモデル
 * （CAM++系, 完全ローカル）で声のベクトルを抽出し, DBに登録済みの話者と
 * コサイン類似度で照合する. 閾値以上なら本人, 未満なら「ゲストA」等の仮ラベルを
 * 与えてセッション内でクラスタリングし, 名前を教われば enroll でそのクラスタの
 * 声サンプルごと正式登録する（＝声を覚える）.
 *
 * モデル未配置・アドオン読み込み失敗時は無効化され, 会話機能には影響しない.
 */

/** 1発話の識別結果 */
export interface SpeakerMatch {
  /** 表示・履歴用ラベル（登録名 または「ゲストA」等） */
  label: string;
  /** 登録済み話者に一致したか */
  known: boolean;
  /** 一致した登録話者のDB id（known のとき） */
  speakerId?: string;
  /** コサイン類似度（デバッグ・ログ用） */
  score: number;
}

/** 登録済み話者のメモリ上プロファイル */
interface Profile {
  id: string;
  name: string;
  embeddings: Float32Array[];
}

/** 未登録話者のセッション内クラスタ */
interface GuestCluster {
  label: string;
  embeddings: Float32Array[];
  lastActiveAt: number;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 0 ? dot / d : 0;
}

/** プロファイル（複数サンプル）との類似度＝各サンプルとの最大値. */
function bestScore(emb: Float32Array, samples: Float32Array[]): number {
  let best = -1;
  for (const s of samples) {
    const c = cosine(emb, s);
    if (c > best) best = c;
  }
  return best;
}

export class SpeakerIdentifier {
  private extractor: {
    createStream(): {
      acceptWaveform(o: { sampleRate: number; samples: Float32Array }): void;
    };
    compute(stream: unknown): Float32Array;
  } | null = null;

  private profiles: Profile[] = [];
  private guests: GuestCluster[] = [];
  private guestSeq = 0;
  /** 直近の発話の埋め込み（enroll のフォールバック用） */
  private lastEmbedding: Float32Array | null = null;

  constructor(private store: Store) {}

  get available(): boolean {
    return this.extractor !== null;
  }

  /**
   * sherpa-onnx アドオンとモデルを読み込む. 失敗しても例外は投げず,
   * 話者識別を無効化して他機能を巻き込まない.
   */
  async init(): Promise<void> {
    try {
      const mod = (await import("sherpa-onnx-node")) as unknown as {
        default?: Record<string, unknown>;
      } & Record<string, unknown>;
      const sherpa = (mod.default ?? mod) as {
        SpeakerEmbeddingExtractor: new (cfg: {
          model: string;
          numThreads: number;
          debug: number;
          provider: string;
        }) => NonNullable<SpeakerIdentifier["extractor"]>;
      };
      this.extractor = new sherpa.SpeakerEmbeddingExtractor({
        model: config.speakerModel,
        numThreads: 1,
        debug: 0,
        provider: "cpu",
      });
      this.reload();
      console.log(
        `[speaker-id] 話者識別を開始（登録済み: ${this.profiles.length}名）`,
      );
    } catch (e) {
      this.extractor = null;
      console.log(
        "[speaker-id] 無効（sherpa-onnx-node またはモデル未整備）:",
        (e as Error).message,
      );
    }
  }

  /** DBから登録話者プロファイルを読み直す（登録・削除後の反映）. */
  private reload(): void {
    this.profiles = this.store.loadSpeakerEmbeddings().map((s) => ({
      id: s.id,
      name: s.name,
      embeddings: s.embeddings.map((v) => Float32Array.from(v)),
    }));
  }

  /** PCM(s16le) から話者埋め込みを計算する. 短すぎる発話は null. */
  private embed(pcm: Buffer): Float32Array | null {
    if (!this.extractor) return null;
    const n = Math.floor(pcm.byteLength / 2);
    if (n < config.speakerMinSec * config.sampleRate) return null;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
    const stream = this.extractor.createStream();
    stream.acceptWaveform({ sampleRate: config.sampleRate, samples });
    return this.extractor.compute(stream);
  }

  /**
   * 発話の話者を識別する. 登録済みに一致すれば名前を, 一致しなければ
   * セッション内ゲストクラスタへ割り当てて「ゲストA」等の仮ラベルを返す.
   * 識別不能（無効・発話が短すぎる）なら null.
   */
  classify(pcm: Buffer): SpeakerMatch | null {
    let emb: Float32Array | null = null;
    try {
      emb = this.embed(pcm);
    } catch (e) {
      console.log("[speaker-id] 埋め込み計算に失敗:", (e as Error).message);
      return null;
    }
    if (!emb) return null;
    this.lastEmbedding = emb;

    // 登録済み話者との照合.
    let best: Profile | null = null;
    let bestS = -1;
    for (const p of this.profiles) {
      const s = bestScore(emb, p.embeddings);
      if (s > bestS) {
        bestS = s;
        best = p;
      }
    }
    if (best && bestS >= config.speakerThreshold) {
      // 高確信の一致は声サンプルとして追記し, 経年変化・環境差へ適応する.
      if (bestS >= config.speakerThreshold + 0.08 && best.embeddings.length < config.speakerMaxSamples) {
        best.embeddings.push(emb);
        this.store.appendSpeakerEmbeddings(best.id, [Array.from(emb)], config.speakerMaxSamples);
      }
      return { label: best.name, known: true, speakerId: best.id, score: bestS };
    }

    // 未登録: セッション内ゲストクラスタへ割り当て（少し緩い閾値で同一人物をまとめる）.
    let bestG: GuestCluster | null = null;
    let bestGS = -1;
    for (const g of this.guests) {
      const s = bestScore(emb, g.embeddings);
      if (s > bestGS) {
        bestGS = s;
        bestG = g;
      }
    }
    if (bestG && bestGS >= config.speakerThreshold - 0.05) {
      if (bestG.embeddings.length < 10) bestG.embeddings.push(emb);
      bestG.lastActiveAt = Date.now();
      return { label: bestG.label, known: false, score: bestGS };
    }
    const label = `ゲスト${String.fromCharCode(65 + (this.guestSeq++ % 26))}`;
    this.guests.push({ label, embeddings: [emb], lastActiveAt: Date.now() });
    if (this.guests.length > 8) this.guests.shift();
    return { label, known: false, score: bestGS };
  }

  /**
   * 未登録話者（ゲストクラスタ）を名前つきで正式登録する（＝声を覚える）.
   * guestLabel 省略時は直近に発話したゲストクラスタを使う. クラスタが無ければ
   * 直近の発話の埋め込みで登録する. 同名の既存話者には声サンプルを統合する.
   */
  enroll(
    name: string,
    reading?: string | null,
    guestLabel?: string,
  ): { ok: boolean; message: string; record?: SpeakerRecord } {
    if (!this.available) {
      return { ok: false, message: "話者識別が無効のため登録できません（モデル未整備）．" };
    }
    let embeddings: number[][] = [];
    let source = "";
    const target = guestLabel
      ? this.guests.find((g) => g.label === guestLabel)
      : [...this.guests].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
    if (target) {
      embeddings = target.embeddings.map((e) => Array.from(e));
      source = `${target.label}の声サンプル${target.embeddings.length}件`;
    } else if (this.lastEmbedding) {
      embeddings = [Array.from(this.lastEmbedding)];
      source = "直近の発話1件";
    } else {
      return {
        ok: false,
        message:
          "登録に使える声サンプルがありません．もう少し長く話してもらってから再度登録してください．",
      };
    }
    const rec = this.store.upsertSpeaker({
      name,
      reading: reading ?? null,
      embeddings,
      maxSamples: config.speakerMaxSamples,
    });
    if (!rec) return { ok: false, message: "話者の登録に失敗しました．" };
    if (target) this.guests = this.guests.filter((g) => g !== target);
    this.reload();
    return {
      ok: true,
      message: `「${name}」さんの声を登録しました（${source}）．以後は声で識別します．`,
      record: rec,
    };
  }

  /** 登録済み話者の一覧. */
  list(): SpeakerRecord[] {
    return this.store.listSpeakers();
  }

  /** 話者の名前を変更する. */
  rename(oldName: string, newName: string, reading?: string | null): boolean {
    const ok = this.store.renameSpeaker(oldName, newName, reading);
    if (ok) this.reload();
    return ok;
  }

  /** 話者の登録を削除する（声を忘れる）. */
  forget(name: string): boolean {
    const ok = this.store.removeSpeaker(name);
    if (ok) this.reload();
    return ok;
  }
}
