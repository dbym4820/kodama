import type { FastifyInstance } from "fastify";
import type { Orchestrator } from "../core/orchestrator.js";

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
}
