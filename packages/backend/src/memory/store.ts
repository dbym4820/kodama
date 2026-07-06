import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BehaviorNote,
  FileRecord,
  MemoryRecord,
  MessageRecord,
  Role,
  SearchHit,
  SessionRecord,
  SpeakerRecord,
  TermRecord,
  TopicRecord,
} from "@kodama/shared";

/**
 * ローカルサーバ完結の永続化層.
 * 構造化データは SQLite, 音声は DATA_DIR/audio 以下のファイルに保存し,
 * 会話履歴・文字起こし・音声・長期メモ・使用量をすべて手元に保持する.
 * クラウドにはデータを残さない（§8.5）.
 */
export class Store {
  private db: Database.Database;
  private readonly audioDir: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.audioDir = join(dataDir, "audio");
    mkdirSync(this.audioDir, { recursive: true });

    this.db = new Database(join(dataDir, "kodama.db"));
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        started_at  TEXT NOT NULL,
        ended_at    TEXT,
        summary     TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL REFERENCES sessions(id),
        role        TEXT NOT NULL,
        text        TEXT NOT NULL,
        audio_path  TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id, created_at);

      CREATE TABLE IF NOT EXISTS memories (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        content     TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_log (
        id            TEXT PRIMARY KEY,
        provider      TEXT NOT NULL,
        kind          TEXT NOT NULL,
        units         REAL NOT NULL,
        cost_estimate REAL,
        created_at    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- 語彙（認識バイアス用）. surface を whisper の prompt へ動的に差し込む（§15.1）.
      CREATE TABLE IF NOT EXISTS terms (
        id          TEXT PRIMARY KEY,
        surface     TEXT NOT NULL UNIQUE,
        reading     TEXT,
        aliases     TEXT NOT NULL DEFAULT '[]',
        kind        TEXT NOT NULL DEFAULT 'other',
        weight      REAL NOT NULL DEFAULT 1,
        source      TEXT NOT NULL DEFAULT 'user',
        hit_count   INTEGER NOT NULL DEFAULT 0,
        active      INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      -- トピック（話題のまとまり）. 会話を定期解析して畳み込んだ要約（§15.2）.
      CREATE TABLE IF NOT EXISTS topics (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        summary     TEXT NOT NULL,
        keywords    TEXT NOT NULL DEFAULT '[]',
        salience    REAL NOT NULL DEFAULT 1,
        started_at  TEXT NOT NULL,
        ended_at    TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_topics_ended ON topics(ended_at);

      -- トピックと元メッセージの対応（出典追跡）.
      CREATE TABLE IF NOT EXISTS topic_messages (
        topic_id    TEXT NOT NULL,
        message_id  TEXT NOT NULL,
        PRIMARY KEY (topic_id, message_id)
      );

      -- 行動指針（谺自身の振る舞いを制御する自己知識）. 半減期で鮮度が減衰する.
      CREATE TABLE IF NOT EXISTS behaviors (
        id             TEXT PRIMARY KEY,
        content        TEXT NOT NULL,
        kind           TEXT NOT NULL DEFAULT 'other',
        permanent      INTEGER NOT NULL DEFAULT 0,
        weight         REAL NOT NULL DEFAULT 1,
        half_life_days REAL NOT NULL DEFAULT 30,
        active         INTEGER NOT NULL DEFAULT 1,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );

      -- アップロードされたファイル. 実体をBLOBでDBに持ち, いつでも取り出せる.
      CREATE TABLE IF NOT EXISTS files (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        mime_type   TEXT NOT NULL,
        size        INTEGER NOT NULL,
        data        BLOB NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_files_created ON files(created_at);

      -- 登録済み話者（声による個人識別）. embeddings は声の埋め込みベクトルの
      -- JSON配列（number[][]）. 発話ごとのコサイン類似度で本人を照合する.
      CREATE TABLE IF NOT EXISTS speakers (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        reading     TEXT,
        embeddings  TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `);

    // 既存DBへの追い付き: messages.speaker（話者識別の結果ラベル）.
    const msgCols = this.db
      .prepare("PRAGMA table_info(messages)")
      .all() as { name: string }[];
    if (!msgCols.some((c) => c.name === "speaker")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN speaker TEXT");
    }
  }

  // --- 設定（人格など, key-value JSON） --------------------------------

  getSetting<T>(key: string): T | null {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(value));
  }

  // --- セッション -------------------------------------------------------

  createSession(): SessionRecord {
    const rec: SessionRecord = {
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      summary: null,
    };
    this.db
      .prepare(
        "INSERT INTO sessions (id, started_at, ended_at, summary) VALUES (?, ?, ?, ?)",
      )
      .run(rec.id, rec.startedAt, rec.endedAt, rec.summary);
    return rec;
  }

  endSession(sessionId: string, summary: string | null = null): void {
    this.db
      .prepare("UPDATE sessions SET ended_at = ?, summary = ? WHERE id = ?")
      .run(new Date().toISOString(), summary, sessionId);
  }

  // --- メッセージ -------------------------------------------------------

  addMessage(input: {
    sessionId: string;
    role: Role;
    text: string;
    audioPath?: string | null;
    speaker?: string | null;
  }): MessageRecord {
    const rec: MessageRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      role: input.role,
      text: input.text,
      audioPath: input.audioPath ?? null,
      speaker: input.speaker ?? null,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, role, text, audio_path, speaker, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.sessionId,
        rec.role,
        rec.text,
        rec.audioPath,
        rec.speaker,
        rec.createdAt,
      );
    return rec;
  }

  recentMessages(sessionId: string, limit = 50): MessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id AS sessionId, role, text,
                audio_path AS audioPath, speaker, created_at AS createdAt
         FROM messages WHERE session_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(sessionId, limit) as MessageRecord[];
    return rows.reverse();
  }

  // --- 音声ファイル -----------------------------------------------------

  /** 音声を DATA_DIR/audio/<session>/<id>-<role>.<ext> に保存しパスを返す */
  saveAudio(
    sessionId: string,
    role: Role,
    data: Buffer,
    ext = "wav",
  ): string {
    const dir = join(this.audioDir, sessionId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${randomUUID()}-${role}.${ext}`);
    writeFileSync(path, data);
    return path;
  }

  // --- 行動指針（自己知識, 鮮度＝半減期つき） ---------------------------

  private rowToBehavior(r: Record<string, unknown>): BehaviorNote {
    return {
      id: String(r.id),
      content: String(r.content),
      kind: String(r.kind),
      permanent: Number(r.permanent) !== 0,
      weight: Number(r.weight),
      halfLifeDays: Number(r.half_life_days),
      active: Number(r.active) !== 0,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  /**
   * 鮮度（0〜1）. 恒久的な指針は常に1, それ以外は最終確認時刻（updatedAt）から
   * 半減期 halfLifeDays で指数減衰する. 再確認（refresh）で1に戻る.
   */
  behaviorFreshness(n: BehaviorNote, atMs = Date.now()): number {
    if (n.permanent) return 1;
    const ageDays = Math.max(0, atMs - Date.parse(n.updatedAt)) / 86_400_000;
    const halfLife = n.halfLifeDays > 0 ? n.halfLifeDays : 30;
    return Math.pow(2, -ageDays / halfLife);
  }

  /**
   * 行動指針を保存する. 同一内容の有効な指針が既にあれば重複登録せず,
   * その指針を再確認（鮮度リセット＋指定項目の上書き）として扱う.
   */
  addBehavior(input: {
    content: string;
    kind?: string;
    permanent?: boolean;
    weight?: number;
    halfLifeDays?: number;
  }): BehaviorNote | null {
    const content = input.content.trim();
    if (!content) return null;
    const now = new Date().toISOString();
    const existing = this.db
      .prepare("SELECT * FROM behaviors WHERE content = ? AND active = 1")
      .get(content) as Record<string, unknown> | undefined;
    if (existing) {
      const prev = this.rowToBehavior(existing);
      return this.updateBehavior(prev.id, {
        kind: input.kind,
        permanent: input.permanent,
        weight: input.weight,
        halfLifeDays: input.halfLifeDays,
        refresh: true,
      });
    }
    const rec: BehaviorNote = {
      id: randomUUID(),
      content,
      kind: input.kind ?? "other",
      permanent: input.permanent ?? false,
      weight: input.weight ?? 1,
      halfLifeDays: input.halfLifeDays ?? 30,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO behaviors (id, content, kind, permanent, weight, half_life_days, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.content,
        rec.kind,
        rec.permanent ? 1 : 0,
        rec.weight,
        rec.halfLifeDays,
        1,
        rec.createdAt,
        rec.updatedAt,
      );
    return rec;
  }

  /**
   * 行動指針を鮮度つきで一覧する. 有効なものを（重要度×鮮度）の高い順に返し,
   * includeInactive=true なら廃止済みも末尾に含める.
   */
  listBehaviors(
    includeInactive = false,
  ): (BehaviorNote & { freshness: number })[] {
    const now = Date.now();
    const rows = this.db
      .prepare(
        includeInactive
          ? "SELECT * FROM behaviors"
          : "SELECT * FROM behaviors WHERE active = 1",
      )
      .all() as Record<string, unknown>[];
    const notes = rows.map((r) => {
      const n = this.rowToBehavior(r);
      return { ...n, freshness: this.behaviorFreshness(n, now) };
    });
    notes.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return b.weight * b.freshness - a.weight * a.freshness;
    });
    return notes;
  }

  /**
   * 行動指針を更新する. id は先頭一致（8文字プレフィクス等）でよいが,
   * 複数に一致する場合は安全のため更新しない. refresh=true で鮮度を今に戻す.
   */
  updateBehavior(
    idPrefix: string,
    patch: {
      content?: string;
      kind?: string;
      permanent?: boolean;
      weight?: number;
      halfLifeDays?: number;
      active?: boolean;
      refresh?: boolean;
    },
  ): BehaviorNote | null {
    const rows = this.db
      .prepare("SELECT * FROM behaviors WHERE id LIKE ?")
      .all(`${idPrefix.trim()}%`) as Record<string, unknown>[];
    if (rows.length !== 1) return null;
    const prev = this.rowToBehavior(rows[0]!);
    const next: BehaviorNote = {
      ...prev,
      content: patch.content?.trim() || prev.content,
      kind: patch.kind ?? prev.kind,
      permanent: patch.permanent ?? prev.permanent,
      weight: patch.weight ?? prev.weight,
      halfLifeDays: patch.halfLifeDays ?? prev.halfLifeDays,
      active: patch.active ?? prev.active,
      updatedAt: patch.refresh
        ? new Date().toISOString()
        : prev.updatedAt,
    };
    this.db
      .prepare(
        `UPDATE behaviors SET content=?, kind=?, permanent=?, weight=?, half_life_days=?, active=?, updated_at=?
         WHERE id = ?`,
      )
      .run(
        next.content,
        next.kind,
        next.permanent ? 1 : 0,
        next.weight,
        next.halfLifeDays,
        next.active ? 1 : 0,
        next.updatedAt,
        prev.id,
      );
    return next;
  }

  // --- ファイル（バイナリをDBに格納） -----------------------------------

  /** アップロードされたファイルの実体をBLOBとして保存し, メタデータを返す. */
  saveFile(input: { name: string; mimeType: string; data: Buffer }): FileRecord {
    const rec: FileRecord = {
      id: randomUUID(),
      name: input.name,
      mimeType: input.mimeType,
      size: input.data.byteLength,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO files (id, name, mime_type, size, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(rec.id, rec.name, rec.mimeType, rec.size, input.data, rec.createdAt);
    return rec;
  }

  /** ファイルの実体（バイナリ）とメタデータを取り出す. */
  getFile(id: string): { meta: FileRecord; data: Buffer } | null {
    const row = this.db
      .prepare(
        `SELECT id, name, mime_type AS mimeType, size, data, created_at AS createdAt
         FROM files WHERE id = ?`,
      )
      .get(id) as (FileRecord & { data: Buffer }) | undefined;
    if (!row) return null;
    const { data, ...meta } = row;
    return { meta, data };
  }

  /** メタデータのみ取り出す（BLOB本体は読まない）. */
  getFileMeta(id: string): FileRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, name, mime_type AS mimeType, size, created_at AS createdAt
         FROM files WHERE id = ?`,
      )
      .get(id) as FileRecord | undefined;
    return row ?? null;
  }

  /** メタデータのみの一覧（新しい順）. BLOB本体は読まない. */
  listFiles(limit = 200): FileRecord[] {
    return this.db
      .prepare(
        `SELECT id, name, mime_type AS mimeType, size, created_at AS createdAt
         FROM files ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as FileRecord[];
  }

  deleteFile(id: string): boolean {
    return this.db.prepare("DELETE FROM files WHERE id = ?").run(id).changes > 0;
  }

  // --- 長期メモ ---------------------------------------------------------

  addMemory(kind: string, content: string): MemoryRecord {
    const rec: MemoryRecord = {
      id: randomUUID(),
      kind,
      content,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO memories (id, kind, content, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(rec.id, rec.kind, rec.content, rec.createdAt);
    return rec;
  }

  /** 単純な全文部分一致での想起（将来はFTS/埋め込みに拡張） */
  searchMemories(query: string, limit = 20): MemoryRecord[] {
    return this.db
      .prepare(
        `SELECT id, kind, content, created_at AS createdAt
         FROM memories WHERE content LIKE ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(`%${query}%`, limit) as MemoryRecord[];
  }

  // --- 語彙（認識バイアス, §15.1） -------------------------------------

  private rowToTerm(r: Record<string, unknown>): TermRecord {
    return {
      id: String(r.id),
      surface: String(r.surface),
      reading: (r.reading as string) ?? null,
      aliases: JSON.parse(String(r.aliases ?? "[]")) as string[],
      kind: String(r.kind),
      weight: Number(r.weight),
      source: String(r.source),
      hitCount: Number(r.hit_count),
      active: Number(r.active) !== 0,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  /**
   * 語彙を登録・更新する（surface で一意）. 既存があれば指定項目だけ更新し,
   * 自動語(auto)が後からユーザ明示(user)で再登録されたら user へ格上げする.
   */
  upsertTerm(input: {
    surface: string;
    reading?: string | null;
    aliases?: string[];
    kind?: string;
    source?: string;
    weight?: number;
    active?: boolean;
  }): TermRecord | null {
    const surface = input.surface.trim();
    if (!surface) return null;
    const now = new Date().toISOString();
    const existing = this.db
      .prepare("SELECT * FROM terms WHERE surface = ?")
      .get(surface) as Record<string, unknown> | undefined;
    if (existing) {
      const prev = this.rowToTerm(existing);
      const source =
        input.source === "user" || prev.source === "user" ? "user" : prev.source;
      const next: TermRecord = {
        ...prev,
        reading: input.reading !== undefined ? input.reading : prev.reading,
        aliases: input.aliases ?? prev.aliases,
        kind: input.kind ?? prev.kind,
        weight: input.weight ?? prev.weight,
        active: input.active ?? prev.active,
        source,
        updatedAt: now,
      };
      this.db
        .prepare(
          `UPDATE terms SET reading=?, aliases=?, kind=?, weight=?, source=?, active=?, updated_at=?
           WHERE surface=?`,
        )
        .run(
          next.reading,
          JSON.stringify(next.aliases),
          next.kind,
          next.weight,
          next.source,
          next.active ? 1 : 0,
          now,
          surface,
        );
      return next;
    }
    const rec: TermRecord = {
      id: randomUUID(),
      surface,
      reading: input.reading ?? null,
      aliases: input.aliases ?? [],
      kind: input.kind ?? "other",
      weight: input.weight ?? 1,
      source: input.source ?? "user",
      hitCount: 0,
      active: input.active ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO terms (id, surface, reading, aliases, kind, weight, source, hit_count, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.surface,
        rec.reading,
        JSON.stringify(rec.aliases),
        rec.kind,
        rec.weight,
        rec.source,
        rec.hitCount,
        rec.active ? 1 : 0,
        rec.createdAt,
        rec.updatedAt,
      );
    return rec;
  }

  listTerms(activeOnly = false): TermRecord[] {
    const sql = activeOnly
      ? "SELECT * FROM terms WHERE active = 1 ORDER BY weight DESC, updated_at DESC"
      : "SELECT * FROM terms ORDER BY weight DESC, updated_at DESC";
    return (this.db.prepare(sql).all() as Record<string, unknown>[]).map((r) =>
      this.rowToTerm(r),
    );
  }

  /** STTヒント用に, 有効な語の表記を重み順で上位 limit 件返す. */
  termHintSurfaces(limit = 64): string[] {
    const rows = this.db
      .prepare(
        "SELECT surface FROM terms WHERE active = 1 ORDER BY weight DESC, updated_at DESC LIMIT ?",
      )
      .all(limit) as { surface: string }[];
    return rows.map((r) => r.surface);
  }

  setTermActive(surface: string, active: boolean): boolean {
    const r = this.db
      .prepare("UPDATE terms SET active = ?, updated_at = ? WHERE surface = ?")
      .run(active ? 1 : 0, new Date().toISOString(), surface.trim());
    return r.changes > 0;
  }

  removeTerm(surface: string): boolean {
    const r = this.db
      .prepare("DELETE FROM terms WHERE surface = ?")
      .run(surface.trim());
    return r.changes > 0;
  }

  // --- トピック（定期要約, §15.2） -------------------------------------

  private rowToTopic(r: Record<string, unknown>): TopicRecord {
    return {
      id: String(r.id),
      title: String(r.title),
      summary: String(r.summary),
      keywords: JSON.parse(String(r.keywords ?? "[]")) as string[],
      salience: Number(r.salience),
      startedAt: String(r.started_at),
      endedAt: String(r.ended_at),
      updatedAt: String(r.updated_at),
    };
  }

  /** 新規トピックを作成する. */
  createTopic(input: {
    title: string;
    summary: string;
    keywords?: string[];
    salience?: number;
    startedAt: string;
    endedAt: string;
  }): TopicRecord {
    const now = new Date().toISOString();
    const rec: TopicRecord = {
      id: randomUUID(),
      title: input.title,
      summary: input.summary,
      keywords: input.keywords ?? [],
      salience: input.salience ?? 1,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO topics (id, title, summary, keywords, salience, started_at, ended_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.title,
        rec.summary,
        JSON.stringify(rec.keywords),
        rec.salience,
        rec.startedAt,
        rec.endedAt,
        rec.updatedAt,
      );
    return rec;
  }

  /** 既存トピックへ要約をマージ更新する（継続中の話題に追記）. */
  updateTopic(
    id: string,
    patch: {
      title?: string;
      summary?: string;
      keywords?: string[];
      salience?: number;
      endedAt?: string;
    },
  ): void {
    const cur = this.db.prepare("SELECT * FROM topics WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!cur) return;
    const prev = this.rowToTopic(cur);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE topics SET title=?, summary=?, keywords=?, salience=?, ended_at=?, updated_at=? WHERE id=?`,
      )
      .run(
        patch.title ?? prev.title,
        patch.summary ?? prev.summary,
        JSON.stringify(patch.keywords ?? prev.keywords),
        patch.salience ?? prev.salience,
        patch.endedAt ?? prev.endedAt,
        now,
        id,
      );
  }

  linkTopicMessages(topicId: string, messageIds: string[]): void {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO topic_messages (topic_id, message_id) VALUES (?, ?)",
    );
    const tx = this.db.transaction((ids: string[]) => {
      for (const mid of ids) stmt.run(topicId, mid);
    });
    tx(messageIds);
  }

  recentTopics(limit = 12): TopicRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM topics ORDER BY ended_at DESC LIMIT ?")
        .all(limit) as Record<string, unknown>[]
    ).map((r) => this.rowToTopic(r));
  }

  /** 指定時刻より後（含まない）に作られたメッセージを全セッション横断で返す（要約ジョブ用）. */
  messagesSince(afterIso: string, limit = 200): MessageRecord[] {
    return this.db
      .prepare(
        `SELECT id, session_id AS sessionId, role, text,
                audio_path AS audioPath, speaker, created_at AS createdAt
         FROM messages WHERE created_at > ?
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(afterIso, limit) as MessageRecord[];
  }

  // --- 話者（声による個人識別） -----------------------------------------

  private rowToSpeaker(r: Record<string, unknown>): SpeakerRecord {
    return {
      id: String(r.id),
      name: String(r.name),
      reading: (r.reading as string) ?? null,
      sampleCount: (JSON.parse(String(r.embeddings ?? "[]")) as unknown[]).length,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  /** 登録済み話者の一覧（埋め込み本体は含まないメタデータ）. */
  listSpeakers(): SpeakerRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM speakers ORDER BY updated_at DESC")
        .all() as Record<string, unknown>[]
    ).map((r) => this.rowToSpeaker(r));
  }

  /** 照合用に全話者の埋め込みベクトルを読み込む（起動時・登録時のロード用）. */
  loadSpeakerEmbeddings(): {
    id: string;
    name: string;
    reading: string | null;
    embeddings: number[][];
  }[] {
    const rows = this.db
      .prepare("SELECT id, name, reading, embeddings FROM speakers")
      .all() as { id: string; name: string; reading: string | null; embeddings: string }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      reading: r.reading ?? null,
      embeddings: JSON.parse(r.embeddings) as number[][],
    }));
  }

  /**
   * 話者を登録する（name で一意）. 既存の同名話者がいれば埋め込みを追記統合する.
   * maxSamples を超えた分は古いものから捨てる.
   */
  upsertSpeaker(input: {
    name: string;
    reading?: string | null;
    embeddings: number[][];
    maxSamples?: number;
  }): SpeakerRecord | null {
    const name = input.name.trim();
    if (!name || !input.embeddings.length) return null;
    const max = input.maxSamples ?? 12;
    const now = new Date().toISOString();
    const existing = this.db
      .prepare("SELECT * FROM speakers WHERE name = ?")
      .get(name) as Record<string, unknown> | undefined;
    if (existing) {
      const prev = JSON.parse(String(existing.embeddings ?? "[]")) as number[][];
      const merged = [...prev, ...input.embeddings].slice(-max);
      this.db
        .prepare(
          "UPDATE speakers SET reading = COALESCE(?, reading), embeddings = ?, updated_at = ? WHERE name = ?",
        )
        .run(input.reading ?? null, JSON.stringify(merged), now, name);
      return this.rowToSpeaker({
        ...existing,
        reading: input.reading ?? existing.reading,
        embeddings: JSON.stringify(merged),
        updated_at: now,
      });
    }
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO speakers (id, name, reading, embeddings, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        input.reading ?? null,
        JSON.stringify(input.embeddings.slice(-max)),
        now,
        now,
      );
    return {
      id,
      name,
      reading: input.reading ?? null,
      sampleCount: Math.min(input.embeddings.length, max),
      createdAt: now,
      updatedAt: now,
    };
  }

  /** 確信度の高い照合時に声サンプルを追記して適応する（上限つき）. */
  appendSpeakerEmbeddings(id: string, embeddings: number[][], max = 12): void {
    const row = this.db
      .prepare("SELECT embeddings FROM speakers WHERE id = ?")
      .get(id) as { embeddings: string } | undefined;
    if (!row) return;
    const prev = JSON.parse(row.embeddings) as number[][];
    const merged = [...prev, ...embeddings].slice(-max);
    this.db
      .prepare("UPDATE speakers SET embeddings = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(merged), new Date().toISOString(), id);
  }

  /** 話者の名前・読みを変更する. */
  renameSpeaker(oldName: string, newName: string, reading?: string | null): boolean {
    const r = this.db
      .prepare(
        "UPDATE speakers SET name = ?, reading = COALESCE(?, reading), updated_at = ? WHERE name = ?",
      )
      .run(newName.trim(), reading ?? null, new Date().toISOString(), oldName.trim());
    return r.changes > 0;
  }

  /** 話者の登録を削除する（声を忘れる）. */
  removeSpeaker(name: string): boolean {
    const r = this.db
      .prepare("DELETE FROM speakers WHERE name = ?")
      .run(name.trim());
    return r.changes > 0;
  }

  // --- 横断検索（全データ参照, §15.3） ---------------------------------

  /**
   * 会話・トピック要約・長期メモ・語彙を横断して部分一致検索する.
   * 谺が「DB内のすべて」を想起源にできるようにする（§15.3）.
   * scope で対象を絞れる（既定は全部）.
   */
  searchAll(
    query: string,
    opts: { scope?: SearchHit["source"][]; limit?: number } = {},
  ): SearchHit[] {
    const q = query.trim();
    if (!q) return [];
    const like = `%${q}%`;
    const limit = opts.limit ?? 30;
    const scope = opts.scope;
    const want = (s: SearchHit["source"]) => !scope || scope.includes(s);
    const hits: SearchHit[] = [];

    if (want("message")) {
      const rows = this.db
        .prepare(
          `SELECT id, role, text, created_at AS createdAt
           FROM messages WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?`,
        )
        .all(like, limit) as {
        id: string;
        role: string;
        text: string;
        createdAt: string;
      }[];
      for (const r of rows) {
        hits.push({
          source: "message",
          id: r.id,
          title: r.role === "assistant" ? "谺の発話" : "あなたの発話",
          snippet: r.text,
          at: r.createdAt,
        });
      }
    }

    if (want("topic")) {
      const rows = this.db
        .prepare(
          `SELECT id, title, summary, keywords, ended_at AS at
           FROM topics WHERE title LIKE ? OR summary LIKE ? OR keywords LIKE ?
           ORDER BY ended_at DESC LIMIT ?`,
        )
        .all(like, like, like, limit) as {
        id: string;
        title: string;
        summary: string;
        at: string;
      }[];
      for (const r of rows) {
        hits.push({
          source: "topic",
          id: r.id,
          title: r.title,
          snippet: r.summary,
          at: r.at,
        });
      }
    }

    if (want("memory")) {
      const rows = this.db
        .prepare(
          `SELECT id, kind, content, created_at AS at
           FROM memories WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?`,
        )
        .all(like, limit) as {
        id: string;
        kind: string;
        content: string;
        at: string;
      }[];
      for (const r of rows) {
        hits.push({
          source: "memory",
          id: r.id,
          title: `メモ(${r.kind})`,
          snippet: r.content,
          at: r.at,
        });
      }
    }

    if (want("term")) {
      const rows = this.db
        .prepare(
          `SELECT id, surface, reading, kind, updated_at AS at
           FROM terms WHERE surface LIKE ? OR reading LIKE ? OR aliases LIKE ?
           ORDER BY weight DESC LIMIT ?`,
        )
        .all(like, like, like, limit) as {
        id: string;
        surface: string;
        reading: string | null;
        kind: string;
        at: string;
      }[];
      for (const r of rows) {
        hits.push({
          source: "term",
          id: r.id,
          title: `語彙(${r.kind})`,
          snippet: r.reading ? `${r.surface}（${r.reading}）` : r.surface,
          at: r.at,
        });
      }
    }

    // 新しい順に統合して返す.
    hits.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return hits.slice(0, limit);
  }

  // --- 使用量ログ（コスト可視化） --------------------------------------

  logUsage(
    provider: string,
    kind: string,
    units: number,
    costEstimate: number | null = null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO usage_log (id, provider, kind, units, cost_estimate, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        provider,
        kind,
        units,
        costEstimate,
        new Date().toISOString(),
      );
  }

  close(): void {
    this.db.close();
  }
}
