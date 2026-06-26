#!/usr/bin/env bash
# 谺(kodama) ネイティブモジュール(better-sqlite3)を現行の system Node 向けに再ビルドする.
#
# dev 経路（npm run app / dev / serve / dev:backend）はバックエンドを tsx＝system Node で
# 動かすため, Node を上げて ABI(process.versions.modules)が変わると, 既存の
# better_sqlite3.node が「NODE_MODULE_VERSION mismatch」で読み込めなくなる. その場合に実行する.
#
# Python 3.12+ は標準ライブラリから distutils を削除しており, node-gyp が
# "No module named 'distutils'" で失敗する. build.sh と同じく setuptools(distutils 互換 shim)を
# 入れた専用 venv を Dropbox 外に用意し, node-gyp にその Python を使わせる.
set -euo pipefail

GYP_VENV="${GYP_VENV:-$HOME/.kodama-build/py}"

if ! "$GYP_VENV/bin/python" -c "import distutils" >/dev/null 2>&1; then
  echo "[rebuild-native] node-gyp 用 Python(venv) を準備: $GYP_VENV"
  python3 -m venv "$GYP_VENV"
  "$GYP_VENV/bin/python" -m pip install -q --disable-pip-version-check --upgrade pip setuptools
  "$GYP_VENV/bin/python" -c "import distutils"
fi

export PYTHON="$GYP_VENV/bin/python"
export npm_config_python="$GYP_VENV/bin/python"

echo "[rebuild-native] better-sqlite3 を再ビルド中（node $(node --version), ABI $(node -p process.versions.modules)）…"
npm rebuild better-sqlite3

node -e "const D=require('better-sqlite3'); new D(':memory:').exec('create table t(x)'); console.log('[rebuild-native] OK: better-sqlite3 が ABI', process.versions.modules, 'で読み込めました')"
