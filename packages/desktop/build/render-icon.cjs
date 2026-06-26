// icon.svg を透過PNG(1024)へレンダリングする補助スクリプト.
// qlmanageは透過を白で潰すため, Electron(Chromium)で透過キャプチャする.
//   実行: node_modules/.bin/electron packages/desktop/build/render-icon.cjs
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, "icon.svg"), "utf8");
  const html =
    "<!doctype html><html><head><meta charset='utf-8'>" +
    "<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>" +
    "</head><body>" +
    svg +
    "</body></html>";

  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    useContentSize: true,
    webPreferences: { offscreen: true },
  });

  await win.loadURL(
    "data:text/html;charset=utf-8," + encodeURIComponent(html),
  );
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.capturePage();
  fs.writeFileSync(path.join(__dirname, "icon-1024.png"), img.toPNG());
  win.destroy();
  app.quit();
});
