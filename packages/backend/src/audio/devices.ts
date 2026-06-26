import { spawn } from "node:child_process";
import type { AudioDevice } from "@kodama/shared";
import { frameRms } from "./vad.js";

/**
 * 音声入出力デバイスの列挙・テストを ffmpeg バイナリのみで行う（macOS）.
 * 入力は avfoundation, 出力は CoreAudio(audiotoolbox) のデバイス一覧を取得する.
 * ネイティブaddonに依存せず, 設定画面からの切り替え・動作確認に用いる.
 */

/** CoreAudioが名前を返さない内蔵デバイス(UID)に分かりやすい表示名を当てる. */
const UID_LABELS: Record<string, string> = {
  BuiltInSpeakerDevice: "内蔵スピーカー",
  BuiltInMicrophoneDevice: "内蔵マイク",
  BuiltInHeadphoneOutputDevice: "ヘッドフォン出力",
};

/** ffmpeg を起動し stdout(バイナリ) と stderr(テキスト) を集めて返す. */
function runFfmpeg(
  args: string[],
  timeoutMs = 8000,
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", ["-hide_banner", ...args]);
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.stdout.on("data", (d: Buffer) => out.push(d));
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const done = () => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out), stderr: err });
    };
    proc.on("error", done);
    proc.on("close", done);
  });
}

/**
 * マイク（avfoundation 音声入力）の一覧.
 * `ffmpeg -f avfoundation -list_devices true -i ""` の stderr を解析する.
 */
export async function listInputDevices(): Promise<AudioDevice[]> {
  const { stderr } = await runFfmpeg([
    "-f",
    "avfoundation",
    "-list_devices",
    "true",
    "-i",
    "",
  ]);
  const devices: AudioDevice[] = [];
  let inAudio = false;
  for (const line of stderr.split("\n")) {
    if (/AVFoundation audio devices:/.test(line)) {
      inAudio = true;
      continue;
    }
    if (/AVFoundation video devices:/.test(line)) {
      inAudio = false;
      continue;
    }
    if (!inAudio) continue;
    const m = line.match(/\]\s+\[(\d+)\]\s+(.+?)\s*$/);
    if (m) devices.push({ index: Number(m[1]), name: (m[2] ?? "").trim() });
  }
  return devices;
}

/**
 * スピーカー（CoreAudio 出力）の一覧.
 * 無音を audiotoolbox に通しつつ `-list_devices true` で列挙する.
 * 一覧には入力専用デバイスも含まれるため, 利用者がスピーカーを選ぶ前提.
 */
export async function listOutputDevices(): Promise<AudioDevice[]> {
  const { stderr } = await runFfmpeg([
    "-loglevel",
    "info",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=8000:cl=mono",
    "-t",
    "0.05",
    "-f",
    "audiotoolbox",
    "-list_devices",
    "true",
    "-",
  ]);
  const devices: AudioDevice[] = [];
  for (const line of stderr.split("\n")) {
    const m = line.match(/\[AudioToolbox[^\]]*\]\s+\[(\d+)\]\s+(.+)$/);
    if (!m) continue;
    const index = Number(m[1]);
    const rest = (m[2] ?? "").trim();
    const ci = rest.lastIndexOf(",");
    let name = ci >= 0 ? rest.slice(0, ci).trim() : rest;
    const uid = ci >= 0 ? rest.slice(ci + 1).trim() : "";
    if (!name || name === "(null)") {
      name = UID_LABELS[uid] ?? uid ?? `デバイス${index}`;
    }
    devices.push({ index, name });
  }
  return devices;
}

/**
 * 指定した avfoundation 入力デバイスから短時間録音し, 拾えた音量(ピークRMS)を測る.
 * 常駐マイクが動いていない設定（テスト前の切替直後など）でも単発で確認できる.
 */
export function captureInputLevel(
  audioIndex: number,
  sampleRate: number,
  ms = 1500,
): Promise<{ level: number; ok: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "avfoundation",
      "-i",
      `:${audioIndex}`,
      "-t",
      (ms / 1000).toFixed(2),
      "-ar",
      String(sampleRate),
      "-ac",
      "1",
      "-f",
      "s16le",
      "pipe:1",
    ]);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => proc.kill("SIGKILL"), ms + 2500);
    proc.stdout.on("data", (d: Buffer) => chunks.push(d));
    proc.on("error", () => {});
    proc.on("close", () => {
      clearTimeout(timer);
      const pcm = Buffer.concat(chunks);
      let peak = 0;
      const frameBytes = 1024;
      for (let i = 0; i + frameBytes <= pcm.length; i += frameBytes) {
        const r = frameRms(pcm.subarray(i, i + frameBytes));
        if (r > peak) peak = r;
      }
      resolve({ level: Math.min(1, peak), ok: peak >= 0.01 });
    });
  });
}

/**
 * 指定した出力デバイスへテスト音（短いサイン波）を再生する.
 * deviceIndex が負ならシステム既定の出力に鳴らす.
 */
export function playTestTone(deviceIndex: number, ms = 600): Promise<void> {
  return new Promise((resolve) => {
    const sec = (ms / 1000).toFixed(2);
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=660:duration=${sec}`,
      "-af",
      `afade=t=in:d=0.05,afade=t=out:st=${(ms / 1000 - 0.12).toFixed(2)}:d=0.12,volume=0.4`,
      "-f",
      "audiotoolbox",
    ];
    if (deviceIndex >= 0) args.push("-audio_device_index", String(deviceIndex));
    args.push("-");
    const proc = spawn("ffmpeg", args);
    const timer = setTimeout(() => proc.kill("SIGKILL"), ms + 3000);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    proc.on("error", done);
    proc.on("close", done);
  });
}
