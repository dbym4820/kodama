# public/

Electron デスクトップアプリのパッケージ出力先（配布物置き場）.

`npm run dist`（= electron-builder）を実行すると, ここに macOS アプリ（`.app`）と
インストーラ（`.dmg`）が生成される（electron-builder の `directories.output` を
このディレクトリに設定済み）.

生成物（`.app` / `.dmg` / `mac*/` 等）はビルド成果物のためバージョン管理しない
（この README のみ追跡する）.
