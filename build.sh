#!/usr/bin/env bash
#
# build.sh — 谺(kodama) 配布ビルドスクリプト
#
# 次の4工程を順に実行し，配布用 Mac アプリを生成して public/ 直下へ配置する．
#   1. フロントエンドのビルド   (packages/frontend → dist を Vite で生成)
#   2. バックエンドの更新       (packages/backend を esbuild で dist へバンドル＋
#                               ネイティブモジュール better-sqlite3 を Electron ABI 向けに再ビルド)
#   3. Electron アプリのビルド   (electron-builder で .dmg と .app を生成)
#   4. ビルド結果の配置          (生成された Mac アプリ(.app)/.dmg を public/ 直下へ配置)
#
# 重要 — Dropbox 配下では同期によるファイル退避(dataless 化)が起き，node_modules の
# ネイティブバイナリ(electron-builder の app-builder バイナリ等)がビルド中に消えて失敗する．
# そのため本スクリプトはソースを Dropbox 外の作業ディレクトリへ複製し，依存インストールと
# ビルドの一切をそこで実行する．完成した .app/.dmg のみを Dropbox 配下の public/ へ戻す．
#
# 使い方:
#   ./build.sh                 通常ビルド
#   ./build.sh --skip-install  依存関係インストール(npm ci)を省略(作業ディレクトリの node_modules を再利用)
#   ./build.sh --skip-native   better-sqlite3 の Electron ABI 再ビルドを省略
#   ARCH=x64 ./build.sh        ターゲットアーキテクチャを指定(既定: ホストarch)
#
# 環境変数(任意):
#   BUILD_ROOT  Dropbox 外の作業ディレクトリ(既定: ~/.kodama-build/work)
#   BUILD_OUT   electron-builder の出力先(既定: ~/.kodama-build/dist-out)
#   GYP_VENV    node-gyp 用 Python venv(既定: ~/.kodama-build/py)
#
set -euo pipefail

# --- 基本設定 -----------------------------------------------------------------
# SRC_DIR : 真のソース(Dropbox 配下)．成果物の最終配置先 public/ もここを基準にする．
# BUILD_ROOT : Dropbox 外の作業ディレクトリ．依存インストールとビルドはすべてここで行う．
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC_DIR="$SRC_DIR/public"

BUILD_ROOT="${BUILD_ROOT:-$HOME/.kodama-build/work}"
BUILD_OUT="${BUILD_OUT:-$HOME/.kodama-build/dist-out}"
GYP_VENV="${GYP_VENV:-$HOME/.kodama-build/py}"

# 作業ディレクトリ内のパス(複製後に存在する)．
FRONTEND_DIST="$BUILD_ROOT/packages/frontend/dist"
BACKEND_SRC="$BUILD_ROOT/packages/backend/src/index.ts"
BACKEND_DIST="$BUILD_ROOT/packages/backend/dist"

ELECTRON_VERSION=""
ARCH="${ARCH:-$(node -p "process.arch")}"

SKIP_INSTALL=0
SKIP_NATIVE=0
for arg in "$@"; do
  case "$arg" in
    --skip-install) SKIP_INSTALL=1 ;;
    --skip-native)  SKIP_NATIVE=1 ;;
    -h|--help)
      # 先頭の連続したコメントブロック(使い方)のみを表示する．
      awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
      exit 0
      ;;
    *) echo "未知の引数: $arg" >&2; exit 2 ;;
  esac
done

# --- ログ用ユーティリティ -----------------------------------------------------
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
die()  { printf '\n\033[1;31mビルド失敗: %s\033[0m\n' "$1" >&2; exit 1; }

START_TS=$(date +%s)

step "谺(kodama) ビルド開始  (arch=${ARCH})"
info "ソース      : $SRC_DIR"
info "作業ディレクトリ: $BUILD_ROOT"

# --- 0a. node-gyp 用 Python のブートストラップ --------------------------------
# ネイティブモジュール(better-sqlite3)のコンパイルには node-gyp が Python を必要とする．
# Python 3.12 以降では標準ライブラリから distutils が削除されており，ホストの Python を
# そのまま使うと node-gyp が "No module named 'distutils'" で失敗する．
# そこで setuptools(distutils 互換 shim を提供)を導入した専用 venv を Dropbox 外に作成し，
# npm ci / @electron/rebuild の双方にこの Python を使わせる．
if ! "$GYP_VENV/bin/python" -c "import distutils" >/dev/null 2>&1; then
  step "0/4 node-gyp 用 Python(venv) を準備"
  rm -rf "$GYP_VENV"
  python3 -m venv "$GYP_VENV" || die "Python venv の作成に失敗"
  "$GYP_VENV/bin/python" -m pip install -q --disable-pip-version-check --upgrade pip setuptools \
    || die "venv への setuptools 導入に失敗"
  "$GYP_VENV/bin/python" -c "import distutils" \
    || die "venv の Python から distutils を解決できません"
  info "準備完了: $GYP_VENV"
else
  info "node-gyp 用 Python は準備済み: $GYP_VENV"
fi
# node-gyp / electron-rebuild がこの Python を使うよう環境変数で明示する．
export PYTHON="$GYP_VENV/bin/python"
export npm_config_python="$GYP_VENV/bin/python"

# --- 0b. ソースを Dropbox 外の作業ディレクトリへ複製 --------------------------
# node_modules は除外して複製する(--skip-install 時は作業ディレクトリ側の既存
# node_modules をそのまま再利用するため，--delete の対象からも外す)．
# 生成物(dist/)・大容量ローカル資産(models/data)・出力先(public)も複製しない．
step "0/4 ソースを作業ディレクトリへ複製 (Dropbox 外)"
mkdir -p "$BUILD_ROOT"
rsync -a --delete \
  --exclude='node_modules' \
  --exclude='dist/' \
  --exclude='/public/' \
  --exclude='/data/' \
  --exclude='/models/' \
  --exclude='.git/' \
  --exclude='*.log' \
  --exclude='.DS_Store' \
  "$SRC_DIR/" "$BUILD_ROOT/" \
  || die "ソースの複製(rsync)に失敗"
[[ -f "$BUILD_ROOT/package.json" ]] || die "複製先に package.json が見つかりません: $BUILD_ROOT"
# electron-builder の extraResources が参照する .env を複製する(任意; 無ければ警告のみ)．
if [[ -f "$SRC_DIR/.env" ]]; then
  cp -f "$SRC_DIR/.env" "$BUILD_ROOT/.env"
else
  info "警告: .env が見つかりません(配布アプリに環境設定が同梱されません)"
fi
# Whisper モデル(大容量)を配布アプリへ同梱するため作業ディレクトリへ複製する．
# rsync では models/ を除外しているので, ここで明示的にコピーする(extraResources が参照)．
# cp で実体化することで Dropbox のオンライン専用ファイルもハイドレートされる．
if [[ -d "$SRC_DIR/models" ]]; then
  info "Whisper モデルを複製 (配布アプリへ同梱)"
  mkdir -p "$BUILD_ROOT/models"
  rsync -a "$SRC_DIR/models/" "$BUILD_ROOT/models/" || die "モデルの複製に失敗"
else
  info "警告: models/ が見つかりません(常時文字起こし/ウェイクワードが無効になります)"
fi
info "複製完了"

# 以降の作業はすべて Dropbox 外の作業ディレクトリで行う．
cd "$BUILD_ROOT"

# --- 0. 依存関係 --------------------------------------------------------------
if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  step "0/4 依存関係をインストール (npm ci)"
  if [[ -f "$BUILD_ROOT/package-lock.json" ]]; then
    npm ci
  else
    npm install
  fi
else
  info "依存関係インストールを省略 (--skip-install)"
  [[ -d "$BUILD_ROOT/node_modules" ]] \
    || die "作業ディレクトリに node_modules がありません(--skip-install を外して実行してください)"
fi

# 依存インストール後に electron のバージョンを確定する(electron は workspaces により
# ルート node_modules へホイストされる)．step 2/3 で再ビルド・パッケージングに用いる．
ELECTRON_VERSION="$(node -p "require('electron/package.json').version" 2>/dev/null || echo "")"
[[ -n "$ELECTRON_VERSION" ]] || die "electron が見つかりません(依存インストールを確認してください)"
info "electron バージョン: $ELECTRON_VERSION"

# --- 1. フロントエンドのビルド ------------------------------------------------
step "1/4 フロントエンドをビルド (Vite)"
npm run build --workspace @kodama/frontend
[[ -f "$FRONTEND_DIST/index.html" ]] || die "フロントエンドの成果物が見つかりません: $FRONTEND_DIST"
info "生成: $FRONTEND_DIST"

# --- 2. バックエンドの更新 ----------------------------------------------------
step "2/4 バックエンドをコンパイル (esbuild バンドル)"
rm -rf "$BACKEND_DIST"
mkdir -p "$BACKEND_DIST"

# ESM 形式で単一ファイルにバンドル．ネイティブ依存(better-sqlite3 / sherpa-onnx-node)のみ
# external とし，同梱する node_modules から実行時に解決させる．
node --input-type=module -e "
import { build } from 'esbuild';
await build({
  entryPoints: ['$BACKEND_SRC'],
  outfile: '$BACKEND_DIST/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  external: ['better-sqlite3', 'sherpa-onnx-node'],
  banner: { js: \"import { createRequire } from 'module'; const require = createRequire(import.meta.url);\" },
  logLevel: 'info',
});
" || die "esbuild によるバックエンドのバンドルに失敗"
[[ -f "$BACKEND_DIST/index.js" ]] || die "バックエンドの成果物が見つかりません: $BACKEND_DIST/index.js"
info "生成: $BACKEND_DIST/index.js"

# dist を ESM パッケージとして成立させる package.json を生成する．
#  - "type":"module" によりバンドル済み index.js を Node が ESM として実行する．
#  - dependencies に better-sqlite3 を記載し，electron-rebuild が依存ツリーを解決できるようにする．
cat > "$BACKEND_DIST/package.json" <<'JSON'
{
  "name": "@kodama/backend-dist",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "index.js",
  "dependencies": {
    "better-sqlite3": "*",
    "sherpa-onnx-node": "*"
  }
}
JSON

# ネイティブ依存(better-sqlite3 / sherpa-onnx-node)とその実行時依存を dist/node_modules へ
# 同梱する．sherpa-onnx-node はプラットフォーム別パッケージ(sherpa-onnx-darwin-<arch> 等)の
# .node/dylib を相対パスで参照するため，両方を同梱する必要がある(N-API 済みバイナリのため
# Electron ABI 再ビルドは不要)．
info "ネイティブ依存を同梱: better-sqlite3, sherpa-onnx-node"
mkdir -p "$BACKEND_DIST/node_modules"
for mod in better-sqlite3 bindings file-uri-to-path sherpa-onnx-node "sherpa-onnx-darwin-$ARCH"; do
  if [[ -d "$BUILD_ROOT/node_modules/$mod" ]]; then
    rm -rf "$BACKEND_DIST/node_modules/$mod"
    cp -R "$BUILD_ROOT/node_modules/$mod" "$BACKEND_DIST/node_modules/$mod"
  fi
done

# better-sqlite3 を Electron の ABI 向けに再ビルドする(同梱コピーのみを対象とし，
# 開発時(plain Node)用のルート node_modules は変更しない)．
if [[ "$SKIP_NATIVE" -eq 0 ]]; then
  step "2/4 better-sqlite3 を Electron ABI 向けに再ビルド"
  [[ -n "$ELECTRON_VERSION" ]] || die "electron のバージョンを取得できません"
  # CLI は node で直接起動する(bin の実行ビットに依存しない)．
  node "$BUILD_ROOT/node_modules/@electron/rebuild/lib/cli.js" \
      --module-dir "$BACKEND_DIST" \
      --only better-sqlite3 \
      --version "$ELECTRON_VERSION" \
      --arch "$ARCH" \
    || die "better-sqlite3 の Electron 向け再ビルドに失敗"
  [[ -f "$BACKEND_DIST/node_modules/better-sqlite3/build/Release/better_sqlite3.node" ]] \
    || die "再ビルドされたネイティブバイナリが見つかりません"
  info "再ビルド完了"
else
  info "ネイティブ再ビルドを省略 (--skip-native) — 配布アプリで SQLite が動作しない可能性があります"
fi

# --- 3. Electron アプリのビルド -----------------------------------------------
step "3/4 Electron アプリをビルド (electron-builder)"
# desktop の package.json で directories.output が ../../public に設定されているが，
# Dropbox 退避を避けるため出力先(BUILD_OUT)を明示的に上書きする．
# electron 本体は workspaces によりルート node_modules へホイストされており，
# electron-builder の自動バージョン検出では解決できないため electronVersion も明示する．
#
# npmRebuild=false が必須:
#   electron-builder は既定で「production 依存のインストール/ネイティブ再ビルド」を行うが，
#   この工程は appDir(packages/desktop)で npm を実行する．本プロジェクトは npm workspaces
#   構成のため，その npm 実行がルート node_modules にホイストされた devDependencies
#   (electron-builder 自身や app-builder バイナリ)を prune してしまい，実行中の
#   app-builder バイナリが消えて "spawn ... app-builder_arm64 ENOENT" で失敗する．
#   desktop には実行時依存が無く，ネイティブ依存(better-sqlite3)は工程2で Electron ABI
#   向けに再ビルド済みのものを extraResources として同梱するため，この再ビルドは不要．
rm -rf "$BUILD_OUT"
mkdir -p "$BUILD_OUT"
( cd "$BUILD_ROOT/packages/desktop" \
  && node "$BUILD_ROOT/node_modules/electron-builder/cli.js" --mac --"$ARCH" \
       -c.npmRebuild=false \
       -c.electronVersion="$ELECTRON_VERSION" \
       -c.directories.output="$BUILD_OUT" ) \
  || die "electron-builder によるアプリのビルドに失敗"

# --- 4. ビルド結果(Mac用アプリ)の Public への配置 -----------------------------
step "4/4 ビルド結果を public/ へ配置"
mkdir -p "$PUBLIC_DIR"
# electron-builder は出力先(BUILD_OUT)の mac-<arch>/ 配下に .app を，直下に .dmg を生成する．
APP_PATH="$(find "$BUILD_OUT" -maxdepth 2 -name '*.app' -type d 2>/dev/null | head -n 1 || true)"
if [[ -n "$APP_PATH" ]]; then
  APP_NAME="$(basename "$APP_PATH")"
  rm -rf "$PUBLIC_DIR/$APP_NAME"
  cp -R "$APP_PATH" "$PUBLIC_DIR/$APP_NAME"
  info "配置: $PUBLIC_DIR/$APP_NAME"
else
  info "警告: .app が見つかりませんでした (.dmg のみ生成された可能性)"
fi

DMG_SRC="$(find "$BUILD_OUT" -maxdepth 1 -name '*.dmg' -type f 2>/dev/null | head -n 1 || true)"
if [[ -n "$DMG_SRC" ]]; then
  cp -f "$DMG_SRC" "$PUBLIC_DIR/"
  info "配置: $PUBLIC_DIR/$(basename "$DMG_SRC")"
fi

# --- 完了 ---------------------------------------------------------------------
ELAPSED=$(( $(date +%s) - START_TS ))
step "ビルド完了 (${ELAPSED}s)"
info "成果物の出力先: $PUBLIC_DIR"
