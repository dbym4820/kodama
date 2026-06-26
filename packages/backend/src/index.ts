import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { config } from "./config.js";
import { Store } from "./memory/store.js";
import { Orchestrator } from "./core/orchestrator.js";
import { ClaudeClient } from "./brain/claudeClient.js";
import { OpenAIStt } from "./stt/openaiStt.js";
import { OpenAITts } from "./tts/openaiTts.js";
import { LocalTts } from "./tts/localTts.js";
import type { Tts } from "./tts/types.js";
import { WsGateway } from "./server/wsGateway.js";
import { registerHttpApi } from "./server/httpApi.js";

/**
 * 谺(kodama) バックエンド常駐サービスのエントリポイント.
 * ストレージ・オーケストレータ・HTTP/WSサーバを起動し, 知覚〜音声パイプラインを配線する.
 */
async function main() {
  config.requireKeys();

  const store = new Store(config.dataDir);

  const tts: Tts =
    config.ttsEngine === "say" ? new LocalTts() : new OpenAITts();

  let gateway: WsGateway | undefined;
  const orch = new Orchestrator(
    store,
    new ClaudeClient(),
    new OpenAIStt(),
    tts,
    (ev) => gateway?.broadcast(ev),
  );

  const app = Fastify({ logger: true });
  app.get("/health", async () => ({ ok: true, dataDir: config.dataDir }));
  registerHttpApi(app, orch);

  // ビルド済みフロントエンド(dist)を同一オリジンで配信する（バックエンドが一体ホスト）.
  const here = dirname(fileURLToPath(import.meta.url));
  const frontendDist =
    config.frontendDist || resolve(here, "../../frontend/dist");
  if (existsSync(resolve(frontendDist, "index.html"))) {
    await app.register(fastifyStatic, { root: frontendDist });
    // SPA: API/WS/health 以外のGETは index.html を返す.
    app.setNotFoundHandler((req, reply) => {
      if (
        req.method === "GET" &&
        !req.url.startsWith("/api") &&
        !req.url.startsWith("/ws") &&
        !req.url.startsWith("/health")
      ) {
        return reply.sendFile("index.html");
      }
      reply.code(404).send({ error: "not found" });
    });
    app.log.info(`フロントエンド配信: ${frontendDist}`);
  } else {
    app.log.warn(
      `フロントエンド未ビルド（${frontendDist}）．\`npm run build:web\` を実行してください．`,
    );
  }

  await app.listen({ port: config.port, host: "0.0.0.0" });

  gateway = new WsGateway(app, (cmd) => orch.handleCommand(cmd));
  await orch.start();

  app.log.info(`谺(kodama) 起動完了  http://localhost:${config.port}`);

  const shutdown = async () => {
    orch.stop();
    store.close();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("起動に失敗しました:", err);
  process.exit(1);
});
