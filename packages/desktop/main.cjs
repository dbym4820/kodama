// 谺(kodama) Electron メインプロセス.
// バックエンド常駐サービスを自動起動し, /health の応答を待ってから
// バックエンドが一体ホストするWeb UI(http://localhost:PORT)をウィンドウで開く.
// グローバルショートカット（設定画面を開く / ヒアリングモード開始）もここで登録し,
// 設定変更はバックエンドのWebSocket("shortcuts"イベント)で受けて即時に再登録する.
const {
  app,
  BrowserWindow,
  shell,
  dialog,
  nativeImage,
  globalShortcut,
} = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");

// アプリアイコン（Dock/ウィンドウ）.
const ICON_PATH = path.join(__dirname, "build", "icon-1024.png");
const appIcon = nativeImage.createFromPath(ICON_PATH);

const PORT = Number(process.env.PORT || 52525);
const HEALTH = `http://127.0.0.1:${PORT}/health`;
const APP_URL = `http://localhost:${PORT}`;

// dev: リポジトリ直下。packaged: resources 配下に同梱した成果物を使う。
const repoRoot = path.resolve(__dirname, "..", "..");

let backend = null;
let win = null;

/** /health に1回だけGETして起動済みか確認する */
function ping(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1200, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** バックエンドが応答するまでポーリングする */
async function waitForBackend(timeoutMs = 40000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await ping(HEALTH)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * GUI(Finder)起動時のPATHには /opt/homebrew/bin 等が無く, バックエンドが
 * ffmpeg/ffplay/whisper-cli/say を見つけられない. 代表的なbinを補ったPATHを返す.
 */
function pathWithCommonBins() {
  const extra = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const cur = (process.env.PATH || "").split(":").filter(Boolean);
  for (const p of extra) if (!cur.includes(p)) cur.push(p);
  return cur.join(":");
}

/** バックエンドを子プロセスとして起動する */
function startBackend() {
  const env = {
    ...process.env,
    PORT: String(PORT),
    PATH: pathWithCommonBins(),
    // 自己改修の再起動要求(exit 87)を本プロセスが監督して再起動する.
    KODAMA_SUPERVISED: "1",
  };

  if (app.isPackaged) {
    // packaged: 同梱した compiled backend を Electron の Node ランタイムで実行する.
    const res = process.resourcesPath;
    const entry = path.join(res, "backend", "index.js");
    backend = spawn(process.execPath, [entry], {
      cwd: res,
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: "1",
        FRONTEND_DIST: path.join(res, "frontend"),
        DATA_DIR: path.join(app.getPath("userData"), "data"),
      },
      stdio: "inherit",
    });
  } else {
    // dev: リポジトリの tsx でソースを直接実行する.
    const tsx = path.join(
      repoRoot,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx",
    );
    const entry = path.join(repoRoot, "packages", "backend", "src", "index.ts");
    backend = spawn(tsx, [entry], { cwd: repoRoot, env, stdio: "inherit" });
  }

  backend.on("error", (err) => {
    dialog.showErrorBox("谺: バックエンド起動失敗", String(err && err.message));
  });
  backend.on("exit", (code) => {
    backend = null;
    // 87 = 自己改修に伴う再起動要求. バックエンドを起動し直して継続する.
    if (code === 87 && !app.isQuitting) {
      startBackend();
      return;
    }
    if (code && code !== 0 && !app.isQuitting) {
      dialog.showErrorBox(
        "谺: バックエンド異常終了",
        `バックエンドが終了しました (code=${code})．APIキー(.env)やffmpegの導入を確認してください．`,
      );
      app.quit();
    }
  });
}

/** バックエンドのJSON APIをGETする（失敗は null） */
function fetchJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** ヒアリングモード開始（手動ウェイク）をバックエンドへ通知する.
 *  発話中はバックエンド側でカットイン（割り込み→傾聴）される. */
function postWake() {
  const req = http.request(
    { host: "127.0.0.1", port: PORT, path: "/api/wake", method: "POST" },
    (res) => res.resume(),
  );
  req.on("error", () => {});
  req.end();
}

/** ウィンドウを前面へ出し, Web UIへ設定画面の開閉イベントを送る. */
function openSettingsWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents
    .executeJavaScript(
      "window.dispatchEvent(new CustomEvent('kodama:open-settings'))",
      true,
    )
    .catch(() => {});
}

/** 現在の設定でグローバルショートカットを登録し直す（変更の即時反映）. */
function applyShortcuts(s) {
  if (!s || typeof s !== "object") return;
  globalShortcut.unregisterAll();
  const register = (accelerator, handler) => {
    if (!accelerator) return;
    try {
      globalShortcut.register(accelerator, handler);
    } catch (e) {
      console.log(`[shortcuts] 登録失敗: ${accelerator}`, e && e.message);
    }
  };
  register(s.openSettings, openSettingsWindow);
  register(s.hearing, postWake);
}

/**
 * ショートカット設定の初期取得と変更の購読.
 * バックエンドのWebSocketへ接続し, 設定画面での保存("shortcuts"イベント)を
 * 受けて即時に再登録する. 切断（バックエンド再起動等）は自動で再接続する.
 */
function watchShortcuts() {
  fetchJson(`http://127.0.0.1:${PORT}/api/shortcuts`).then((s) => {
    if (s) applyShortcuts(s);
  });

  if (typeof WebSocket !== "function") {
    // WebSocketクライアントが無い環境向けのフォールバック（定期再取得）.
    setInterval(() => {
      fetchJson(`http://127.0.0.1:${PORT}/api/shortcuts`).then((s) => {
        if (s) applyShortcuts(s);
      });
    }, 5000);
    return;
  }
  const connect = () => {
    if (app.isQuitting) return;
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    } catch {
      setTimeout(connect, 5000);
      return;
    }
    ws.onmessage = (e) => {
      try {
        const ev = JSON.parse(String(e.data));
        if (ev.type === "shortcuts") applyShortcuts(ev.shortcuts);
      } catch {
        /* 不正なメッセージは無視 */
      }
    };
    ws.onclose = () => {
      if (!app.isQuitting) setTimeout(connect, 3000);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* 無視 */
      }
    };
  };
  connect();
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    title: "谺 kodama",
    backgroundColor: "#0b0d12",
    icon: appIcon,
    webPreferences: { contextIsolation: true },
  });

  // 外部リンクは既定ブラウザで開く.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  await win.loadURL(APP_URL);
}

app.whenReady().then(async () => {
  // Dockアイコン（macOS, 開発起動時）.
  if (process.platform === "darwin" && app.dock && !appIcon.isEmpty()) {
    app.dock.setIcon(appIcon);
  }

  // 既に別プロセスでバックエンドが起動していれば再利用する.
  const already = await ping(HEALTH);
  if (!already) startBackend();

  const ok = await waitForBackend();
  if (!ok) {
    dialog.showErrorBox(
      "谺: バックエンドに接続できません",
      `${HEALTH} が応答しませんでした．`,
    );
    app.quit();
    return;
  }

  await createWindow();

  // グローバルショートカット（Cmd+,=設定 / Ctrl+T=ヒアリング等）を登録し, 変更を購読する.
  watchShortcuts();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 据え付けアプリとして, ウィンドウを閉じたらアプリ全体を終了する.
app.on("window-all-closed", () => app.quit());

app.on("before-quit", () => {
  app.isQuitting = true;
  globalShortcut.unregisterAll();
  if (backend) {
    backend.kill("SIGTERM");
    backend = null;
  }
});
