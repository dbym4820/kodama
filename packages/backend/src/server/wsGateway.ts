import type { FastifyInstance } from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientCommand, ServerEvent } from "@kodama/shared";

/**
 * Web UIへの状態配信とコマンド受信を担うWebSocketゲートウェイ.
 * バックエンドの状態機械・文字起こし・応答デルタをブラウザへリアルタイム配信する.
 */
export class WsGateway {
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();

  constructor(
    server: FastifyInstance,
    private onCommand: (cmd: ClientCommand) => void = () => {},
  ) {
    this.wss = new WebSocketServer({ server: server.server, path: "/ws" });
    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      ws.on("close", () => this.clients.delete(ws));
      ws.on("message", (raw) => {
        try {
          this.onCommand(JSON.parse(raw.toString()) as ClientCommand);
        } catch {
          /* 不正なメッセージは無視 */
        }
      });
    });
  }

  /** 全接続クライアントへイベントを配信 */
  broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }
}
