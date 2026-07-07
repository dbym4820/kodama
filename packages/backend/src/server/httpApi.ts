import type { FastifyInstance } from "fastify";
import type { CameraSettings, ShortcutSettings } from "@kodama/shared";
import type { Orchestrator } from "../core/orchestrator.js";
import { spawnMjpegStream } from "../perception/camera.js";

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

  // カメラのライブプレビュー: RTSP→MJPEG(multipart/x-mixed-replace)へ変換して流す.
  // ブラウザは <img src="/api/camera/stream"> だけでリアルタイム表示できる.
  app.get("/api/camera/stream", async (req, reply) => {
    const url = await orch.getCameraPreviewUrl();
    if (!url) {
      return reply
        .code(404)
        .send({ error: "カメラが未設定です（カメラ設定を保存してください）" });
    }
    reply.hijack();
    const proc = spawnMjpegStream(url);
    reply.raw.writeHead(200, {
      "content-type": "multipart/x-mixed-replace; boundary=ffmpeg",
      "cache-control": "no-cache, no-store",
      connection: "close",
    });
    proc.stdout.pipe(reply.raw);
    const stop = () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* 終了済みは無視 */
      }
    };
    // クライアント切断（設定画面を閉じる等）でffmpegを確実に止める.
    req.raw.on("close", stop);
    proc.on("error", () => {
      stop();
      reply.raw.end();
    });
    proc.on("close", () => reply.raw.end());
  });

  // グローバルショートカット: 参照・保存. 保存は "shortcuts" イベントで配信され,
  // Electron・Web UIが即時に再登録する（リアルタイム反映）.
  app.get("/api/shortcuts", async () => orch.getShortcuts());
  app.post("/api/shortcuts", async (req) =>
    orch.setShortcuts((req.body ?? {}) as Partial<ShortcutSettings>),
  );

  // 手動ウェイク（ヒアリングモード開始）. Electronのグローバルショートカットから叩く.
  // 谺の発話・思考中は割り込んで傾聴へ切り替える（カットイン）.
  app.post("/api/wake", async () => {
    orch.handleCommand({ type: "wake" });
    return { ok: true };
  });

  // 話者（声による個人識別）: 一覧・名前と読みの変更・削除. 変更はDBへ即時反映される.
  app.get("/api/speakers", async () => orch.getSpeakers());
  app.patch("/api/speakers", async (req) => {
    const { name, newName, reading } = (req.body ?? {}) as {
      name?: string;
      newName?: string;
      reading?: string | null;
    };
    const ok = orch.renameSpeaker(
      String(name ?? ""),
      String(newName ?? name ?? ""),
      reading === undefined ? undefined : reading,
    );
    return { ok, speakers: orch.getSpeakers() };
  });
  app.delete("/api/speakers", async (req) => {
    const { name } = (req.query ?? {}) as { name?: string };
    const ok = orch.forgetSpeaker(String(name ?? ""));
    return { ok, speakers: orch.getSpeakers() };
  });
}
