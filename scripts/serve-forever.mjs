// 谺(kodama) 監督プロセス: バックエンドを常駐起動し, 自己改修の再起動と巻き戻しを担う.
//
// - exit code 87 は「自己改修の適用に伴う再起動要求」. 即座に再起動する.
// - 起動直後のクラッシュ時, 自己改修の適用記録（data/selfmod/pending.json）が
//   残っていればバックアップから巻き戻して再起動する（谺は rolledback.json を見て
//   失敗を主人へ口頭報告する）.
// - pending 無しの連続クラッシュは3回で諦めて終了する（クラッシュループ防止）.
//
// 使い方: node scripts/serve-forever.mjs（npm run serve / npm run up から呼ばれる）

import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(repo, process.env.DATA_DIR || "./data");
const selfmodDir = join(dataDir, "selfmod");
const tsx = join(
  repo,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);
const entry = join(repo, "packages", "backend", "src", "index.ts");

let child = null;
let stopping = false;
let crashTimes = [];

/** 適用済み自己改修（pending.json）が残っていればバックアップから巻き戻す. */
function rollbackIfPending(reason) {
  const pendingPath = join(selfmodDir, "pending.json");
  if (!existsSync(pendingPath)) return false;
  try {
    const pending = JSON.parse(readFileSync(pendingPath, "utf8"));
    for (const rel of pending.files ?? []) {
      const backup = join(pending.backupDir, rel);
      const real = join(repo, rel);
      if (existsSync(backup)) {
        mkdirSync(dirname(real), { recursive: true });
        cpSync(backup, real);
      } else {
        // バックアップが無い＝自己改修で新規追加されたファイル. 削除して元に戻す.
        rmSync(real, { force: true });
      }
    }
    rmSync(pendingPath, { force: true });
    writeFileSync(
      join(selfmodDir, "rolledback.json"),
      JSON.stringify({
        at: new Date().toISOString(),
        note: pending.note ?? "",
        reason,
      }),
    );
    console.error(`[serve] 自己改修を巻き戻しました（${reason}）`);
    return true;
  } catch (e) {
    console.error("[serve] 巻き戻しに失敗:", e.message);
    return false;
  }
}

function start() {
  const startedAt = Date.now();
  child = spawn(tsx, [entry], {
    cwd: repo,
    stdio: "inherit",
    env: { ...process.env, KODAMA_SUPERVISED: "1" },
  });
  child.on("exit", (code) => {
    child = null;
    if (stopping) return;
    if (code === 87) {
      console.log("[serve] 再起動要求（自己改修）— 再起動します");
      start();
      return;
    }
    if (code === 0) process.exit(0);

    const now = Date.now();
    crashTimes = crashTimes.filter((t) => now - t < 60_000);
    crashTimes.push(now);
    const fastCrash = now - startedAt < 15_000;

    // 適用直後の起動失敗: 巻き戻して復旧する.
    if ((fastCrash || crashTimes.length >= 2) && rollbackIfPending(`起動失敗 code=${code}`)) {
      start();
      return;
    }
    if (crashTimes.length >= 3) {
      console.error("[serve] 連続クラッシュのため停止します");
      process.exit(code ?? 1);
    }
    console.error(`[serve] 異常終了 code=${code} — 3秒後に再起動します`);
    setTimeout(start, 3000);
  });
  child.on("error", (e) => {
    console.error("[serve] 起動に失敗:", e.message);
    process.exit(1);
  });
}

function stop(signal) {
  stopping = true;
  child?.kill(signal);
  setTimeout(() => process.exit(0), 800);
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

start();
