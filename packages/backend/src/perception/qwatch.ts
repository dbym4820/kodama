import { spawn } from "node:child_process";

/**
 * I-O DATA Qwatch カメラの設定APIクライアント.
 * 仕様: docs/qwatch-api/（`/camera-cgi/admin/param.cgi?action=list&group=...`, Digest認証）.
 * RTSP URL はカメラ設定値から組み立てる:
 *   rtsp://<user>:<pass>@<host>:<rtspPort>/<rtspH264Path>.sdp
 * これによりポートやパスを手で調べずとも接続URLを自動解決できる.
 */
export class QwatchClient {
  constructor(
    private host: string,
    private user: string,
    private pass: string,
  ) {}

  /** param.cgi の生レスポンス（XML風）を取得する（curlでDigest認証）. */
  private cgi(query: string): Promise<string> {
    const url = `http://${this.host}/camera-cgi/admin/param.cgi?${query}`;
    return new Promise((resolve, reject) => {
      const p = spawn("curl", [
        "-s",
        "-m",
        "8",
        "--digest",
        "-u",
        `${this.user}:${this.pass}`,
        url,
      ]);
      let out = "";
      let err = "";
      p.stdout.on("data", (d: Buffer) => (out += d.toString()));
      p.stderr.on("data", (d: Buffer) => (err += d.toString()));
      p.on("error", reject);
      p.on("close", (code) =>
        code === 0 ? resolve(out) : reject(new Error(err.trim() || `curl ${code}`)),
      );
    });
  }

  /** RTSPカテゴリからH.264(またはMJPEG)のRTSP URLを組み立てる. */
  async resolveRtspUrl(
    codec: "h264" | "mjpeg" = "h264",
  ): Promise<string> {
    const xml = await this.cgi("action=list&group=RTSP");
    const port = pick(xml, "rtspPort");
    const tag = codec === "h264" ? "rtspH264Path" : "rtspMJPEGPath";
    const path = pick(xml, tag);
    if (!port || !path) {
      throw new Error("RTSP設定（rtspPort/rtspPath）を取得できませんでした");
    }
    const auth = `${encodeURIComponent(this.user)}:${encodeURIComponent(this.pass)}@`;
    return `rtsp://${auth}${this.host}:${port}/${path}.sdp`;
  }
}

/** `<tag ...>value</tag>` から最初のvalueを取り出す. */
function pick(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`));
  return m ? m[1]!.trim() : null;
}
