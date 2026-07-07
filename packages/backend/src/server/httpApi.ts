import type { FastifyInstance } from "fastify";
import type { CameraSettings } from "@kodama/shared";
import type { Orchestrator } from "../core/orchestrator.js";

/** リクエストボディをカメラ設定（全フィールド文字列）へ正規化する. */
function cameraSettingsFrom(body: unknown): CameraSettings {
  const b = (body ?? {}) as Partial<CameraSettings>;
  return {
    rtspUrl: String(b.rtspUrl ?? "").trim(),
    host: String(b.host ?? "").trim(),
    user: String(b.user ?? "").trim(),
    pass: String(b.pass ?? ""),
  };
}

/** 設定（人格）と会話履歴を扱うREST. すべてローカルサーバ上のデータを返す. */
export function registerHttpApi(app: FastifyInstance, orch: Orchestrator): void {
  app.get("/api/persona", async () => orch.getPersona());
  app.get("/api/history", async () => orch.getHistory());

  // 発音辞書（読み）の参照・登録・削除.
  app.get("/api/lexicon", async () => orch.getLexicon());
  app.post("/api/lexicon", async (req) => {
    const { surface, reading } = (req.body ?? {}) as {
      surface?: string;
      reading?: string;
    };
    return orch.addLexicon(String(surface ?? ""), String(reading ?? ""));
  });
  app.delete("/api/lexicon", async (req) => {
    const { surface } = (req.query ?? {}) as { surface?: string };
    return { ok: orch.removeLexicon(String(surface ?? "")) };
  });

  // 語彙（認識バイアス, §15.1）の参照・登録・有効切替・削除.
  app.get("/api/terms", async () => orch.getTerms());
  app.post("/api/terms", async (req) => {
    const { surface, reading, kind, aliases } = (req.body ?? {}) as {
      surface?: string;
      reading?: string | null;
      kind?: string;
      aliases?: string[];
    };
    return orch.addTerm({
      surface: String(surface ?? ""),
      reading: reading ?? null,
      kind,
      aliases,
    });
  });
  app.patch("/api/terms", async (req) => {
    const { surface, active } = (req.body ?? {}) as {
      surface?: string;
      active?: boolean;
    };
    return orch.setTermActive(String(surface ?? ""), !!active);
  });
  app.delete("/api/terms", async (req) => {
    const { surface } = (req.query ?? {}) as { surface?: string };
    return { ok: orch.removeTerm(String(surface ?? "")) };
  });

  // 行動指針（自己知識）の一覧（鮮度つき, 参照用）.
  app.get("/api/behaviors", async () => orch.getBehaviors());

  // トピック要約（§15.2）の一覧と, DB横断検索（§15.3）.
  app.get("/api/topics", async () => orch.getTopics());
  app.get("/api/search", async (req) => {
    const { q } = (req.query ?? {}) as { q?: string };
    return orch.search(String(q ?? ""));
  });

  // ファイル: アップロード（multipart）→SQLiteへBLOB格納, 一覧・取得・削除.
  app.post("/api/files", async (req, reply) => {
    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ error: "ファイルが添付されていません" });
    }
    const data = await file.toBuffer();
    return orch.saveFile({
      name: file.filename || "untitled",
      mimeType: file.mimetype || "application/octet-stream",
      data,
    });
  });
  app.get("/api/files", async () => orch.listFiles());
  app.get("/api/files/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = orch.getFile(id);
    if (!found) return reply.code(404).send({ error: "not found" });
    return reply
      .header("content-type", found.meta.mimeType)
      .header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(found.meta.name)}`,
      )
      .send(found.data);
  });
  app.delete("/api/files/:id", async (req) => {
    const { id } = req.params as { id: string };
    return { ok: orch.deleteFile(id) };
  });

  // 音声入出力デバイスの一覧・切り替え・テスト.
  app.get("/api/audio/devices", async () => orch.getAudioDevices());
  app.post("/api/audio/input", async (req) => {
    const { index } = (req.body ?? {}) as { index?: number };
    orch.setInputDevice(Number(index ?? 0));
    return { ok: true };
  });
  app.post("/api/audio/output", async (req) => {
    const { index } = (req.body ?? {}) as { index?: number };
    orch.setOutputDevice(Number(index ?? -1));
    return { ok: true };
  });
  app.post("/api/audio/test-input", async () => orch.testInputDevice());
  app.post("/api/audio/test-output", async () => orch.testOutputDevice());

  // カメラ（在室検知）: 設定の参照・保存（保存で再接続）・接続テスト.
  app.get("/api/camera", async () => orch.getCameraInfo());
  app.post("/api/camera", async (req) =>
    orch.setCameraSettings(cameraSettingsFrom(req.body)),
  );
  app.post("/api/camera/test", async (req) =>
    orch.testCamera(cameraSettingsFrom(req.body)),
  );
}
