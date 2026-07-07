// 在室検知（ハイブリッド）の動作確認スクリプト（一時検証用）.
import { config } from "../config.js";
import { CameraPresence } from "../perception/camera.js";
import { PersonDetector } from "../perception/personDetect.js";
import { QwatchClient } from "../perception/qwatch.js";

async function main() {
  let url = config.cameraRtspUrl;
  if (!url && config.cameraHost && config.cameraUser) {
    url = await new QwatchClient(config.cameraHost, config.cameraUser, config.cameraPass).resolveRtspUrl();
  }
  if (!url) throw new Error("カメラ設定がありません");
  const det = new PersonDetector();
  await det.init();
  console.log("[test] detector available:", det.available);
  const r = await det.detect(url);
  console.log("[test] 人物検出:", r);
  const cam = new CameraPresence(
    url,
    {
      pollMs: 1500,
      pixelDiff: config.presencePixelDiff,
      motionRatio: config.presenceMotionRatio,
      globalChangeRatio: config.presenceGlobalChangeRatio,
      holdMs: 20_000, // テスト用に短縮
      detectIntervalMs: 8_000, // テスト用に短縮
      personEnter: config.personScoreThreshold,
      personSustain: config.personScoreSustain,
    },
    det,
  );
  cam.on("presence", (p: boolean) => console.log(`[test] presence -> ${p ? "在室" : "不在"}`));
  cam.on("error", (e: Error) => console.log("[test] error:", e.message));
  cam.start();
  setTimeout(() => {
    cam.stop();
    console.log("[test] 終了, 最終状態:", cam.isPresent() ? "在室" : "不在");
    process.exit(0);
  }, 30_000);
}
main().catch((e) => { console.error(e); process.exit(1); });
