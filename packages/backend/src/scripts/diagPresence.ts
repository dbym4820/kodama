// 在室判定の診断: 動き割合と人物スコアを毎サイクル出力する（検証用）.
import { spawn } from "node:child_process";
import { config } from "../config.js";
import { PersonDetector } from "../perception/personDetect.js";
import { QwatchClient } from "../perception/qwatch.js";

const W = 64, H = 64;

function grabGray(url: string): Promise<Buffer | null> {
  const args = ["-hide_banner","-loglevel","error","-rtsp_transport","tcp","-i",url,
    "-frames:v","1","-vf",`scale=${W}:${H},format=gray`,"-f","rawvideo","pipe:1"];
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", args);
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.on("error", () => resolve(null));
    proc.on("close", () => {
      const b = Buffer.concat(chunks);
      resolve(b.length >= W * H ? b : null);
    });
  });
}

async function main() {
  const url = config.cameraRtspUrl ||
    (await new QwatchClient(config.cameraHost, config.cameraUser, config.cameraPass).resolveRtspUrl());
  const det = new PersonDetector();
  await det.init();
  let prev: Buffer | null = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 75_000) {
    const frame = await grabGray(url);
    let ratio = -1;
    if (frame && prev) {
      let changed = 0;
      for (let i = 0; i < W * H; i++) {
        if (Math.abs((frame[i] ?? 0) - (prev[i] ?? 0)) >= config.presencePixelDiff) changed++;
      }
      ratio = changed / (W * H);
    }
    if (frame) prev = frame;
    const d = await det.detect(url);
    const sec = ((Date.now() - t0) / 1000).toFixed(0).padStart(3);
    console.log(
      `[${sec}s] 動き割合=${ratio < 0 ? "初回" : (ratio * 100).toFixed(2) + "%"}` +
      `（動き判定=${ratio >= config.presenceMotionRatio && ratio < config.presenceGlobalChangeRatio ? "○" : "×"}）` +
      `  人物スコア=${d ? d.score.toFixed(3) : "取得失敗"}（入り${config.personScoreThreshold}/維持${config.personScoreSustain}）`,
    );
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
