// 谺(kodama) 開発用ランチャ: フロントエンドとバックエンドを1コマンドで起動する.
//
// バックエンドは起動時に dist/index.html が在る場合のみ静的配信を登録する
// （packages/backend/src/index.ts）ため, 先にフロントの初回ビルドを完了させてから
// バックエンドを起動し, 以降はフロントを watch ビルドして dist を更新し続ける.
// バックエンドは同一オリジン（http://localhost:8787）でその dist をそのまま配信するので,
// UIを編集したらブラウザを再読込すれば反映される.
//
//   1. npm run build:web        … フロント初回ビルド（完了を待つ）
//   2. tsx watch backend        … バックエンド常駐（src変更で自動再起動）
//   3. vite build --watch       … フロント変更で dist を再ビルド
//
// いずれかが終了したら全体を停止する. Ctrl-C で両方を片付ける.

import { spawn } from "node:child_process";

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

/** 子プロセスを起動し, 出力に色付きプレフィックスを付けて中継する. */
function run(label, color, cmd, args) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const tag = `\x1b[${color}m[${label}]\x1b[0m `;
  const pipe = (src) => {
    let buf = "";
    src.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) process.stdout.write(tag + line + "\n");
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  return child;
}

/** プロセスを起動し, 終了コードで解決する Promise を返す（初回ビルド待ち用）. */
function once(label, color, cmd, args) {
  return new Promise((resolve, reject) => {
    const child = run(label, color, cmd, args);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} が異常終了しました (code=${code})`)),
    );
    child.on("error", reject);
  });
}

const children = [];
let stopping = false;

function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill("SIGINT");
  setTimeout(() => process.exit(code), 300);
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

async function main() {
  // 1) フロント初回ビルド（dist を用意してからバックエンドを起動する）.
  console.log("\x1b[36m[dev]\x1b[0m フロントエンドを初回ビルド中…");
  await once("build", "35", NPM, ["run", "build:web"]);

  // 2) バックエンド常駐（src変更で自動再起動. dist をそのまま配信）.
  const backend = run("backend", "32", NPM, ["run", "dev:backend"]);
  // 3) フロント watch ビルド（変更で dist を再生成 → ブラウザ再読込で反映）.
  const frontend = run("frontend", "35", NPM, [
    "run",
    "build",
    "--workspace",
    "@kodama/frontend",
    "--",
    "--watch",
  ]);
  children.push(backend, frontend);

  console.log(
    "\x1b[36m[dev]\x1b[0m 起動完了 → http://localhost:8787  （UI編集後はブラウザ再読込）",
  );

  for (const c of children) {
    c.on("exit", (code) => {
      if (!stopping) {
        console.error(`\x1b[31m[dev]\x1b[0m 子プロセスが終了しました (code=${code})．停止します．`);
        stopAll(code ?? 1);
      }
    });
  }
}

main().catch((err) => {
  console.error("\x1b[31m[dev]\x1b[0m 起動に失敗:", err.message);
  stopAll(1);
});
