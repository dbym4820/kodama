import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  MemoryRecord,
  MessageRecord,
  Role,
  SessionRecord,
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
    `);
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
  }): MessageRecord {
    const rec: MessageRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      role: input.role,
      text: input.text,
      audioPath: input.audioPath ?? null,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, role, text, audio_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.sessionId,
        rec.role,
        rec.text,
        rec.audioPath,
        rec.createdAt,
      );
    return rec;
  }

  recentMessages(sessionId: string, limit = 50): MessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id AS sessionId, role, text,
                audio_path AS audioPath, created_at AS createdAt
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
