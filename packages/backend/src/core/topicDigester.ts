import type { Store } from "../memory/store.js";
import type { ClaudeClient } from "../brain/claudeClient.js";
import { config } from "../config.js";

/**
 * 会話の定期要約ジョブ（§15.2）.
 *
 * 未要約メッセージの水位線（settings.lastDigestedAt）以降を全セッション横断で読み,
 * Claude（高速モデル）に「同じ話題のかたまり」へ分割・要約させて topics へ畳み込む.
 * 継続中の話題は既存トピックへマージし, 会話に現れた固有名詞・専門語は自動語彙として
 * terms へ登録して認識精度（§15.1）にも還元する. 水位線を進めて再処理を防ぐ.
 *
 * 起動契機は一定間隔のタイマーと, 明示的な flush()（無音区切り・セッション終了時）.
 */
export class TopicDigester {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private store: Store,
    private claude: ClaudeClient,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.digest(), config.digestIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** いま溜まっている未要約メッセージを要約する（多重起動は抑止）. */
  async digest(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const watermark =
        this.store.getSetting<string>("lastDigestedAt") ??
        "1970-01-01T00:00:00.000Z";
      const msgs = this.store.messagesSince(watermark, config.digestBatchMax);
      if (msgs.length < config.digestMinMessages) return;

      const recent = this.store
        .recentTopics(12)
        .map((t) => ({ id: t.id, title: t.title, summary: t.summary }));
      const segments = await this.claude.digestTopics({
        messages: msgs,
        recentTopics: recent,
      });

      for (const seg of segments) {
        const ids = seg.messageIndexes
          .map((i) => msgs[i]?.id)
          .filter((x): x is string => !!x);
        const times = seg.messageIndexes
          .map((i) => msgs[i]?.createdAt)
          .filter((x): x is string => !!x)
          .sort();
        const startedAt = times[0] ?? msgs[0]!.createdAt;
        const endedAt = times[times.length - 1] ?? msgs[msgs.length - 1]!.createdAt;

        let topicId: string;
        if (seg.mergeTopicId && recent.some((r) => r.id === seg.mergeTopicId)) {
          this.store.updateTopic(seg.mergeTopicId, {
            title: seg.title,
            summary: seg.summary,
            keywords: seg.keywords,
            endedAt,
          });
          topicId = seg.mergeTopicId;
        } else {
          topicId = this.store.createTopic({
            title: seg.title,
            summary: seg.summary,
            keywords: seg.keywords,
            startedAt,
            endedAt,
          }).id;
        }
        if (ids.length) this.store.linkTopicMessages(topicId, ids);

        // 抽出された固有名詞・専門語を自動語彙として登録（低weight・有効）.
        // user 明示登録より下位に並び, STTヒント上限内で認識を底上げする（§15.1）.
        for (const term of seg.terms) {
          this.store.upsertTerm({
            surface: term.surface,
            reading: term.reading ?? null,
            kind: term.kind ?? "other",
            source: "auto",
            weight: config.autoTermWeight,
            active: true,
          });
        }
      }

      // 水位線を最後のメッセージ時刻まで進める（要約の成否に関わらず前進させ, 滞留を防ぐ）.
      this.store.setSetting("lastDigestedAt", msgs[msgs.length - 1]!.createdAt);
    } catch (e) {
      console.log("[digest] 要約に失敗:", (e as Error).message);
    } finally {
      this.running = false;
    }
  }
}
