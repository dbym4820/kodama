# 谺 — kodama

研究室据え付け型のAI秘書．「谺（こだま）」＝声を受けて返す反響に由来する．呼びかけ（ウェイクワード）で起動し，**Claudeを頭脳・OpenAIを声**として音声で応答する，ローカルファーストのWebシステム．Web UIには反応するロゴとUIエージェント（アバター）を備える．

設計の全体像は [DESIGN.md](./DESIGN.md) を参照．

## 構成

- **言語**: TypeScript（フロント・バック共通のモノレポ）
- **頭脳**: Claude API（`@anthropic-ai/sdk`）
- **耳**: 完全ローカルの常時ストリーミングSTT（whisper.cpp / `whisper-server` 常駐．確定=large-v3／途中表示=large-v3-turbo）．クラウドへ音声を送らない．OpenAI STT は起動前のフォールバックのみ
- **声**: OpenAI TTS (`gpt-4o-mini-tts`)
- **データ**: 会話履歴・音声・メモはすべてローカル（SQLite + ファイル, `DATA_DIR`）に保持．クラウドには残さない．

```
packages/
  shared/    共有型（イベント・状態・レコードスキーマ）
  backend/   常駐サービス（音声I/O・知覚・パイプライン・API・ストレージ）
  frontend/  Web UI（動くロゴ + 反応するUIエージェント）
```

## Web UI

```bash
npm run dev      # フロント＋バックエンドを1コマンドで起動（http://localhost:52525）
```

フロントエンドはビルドされ，**バックエンドが同一オリジンで一体配信する**（別ポートの開発サーバは不要）．`npm run dev` はフロントを初回ビルドしてからバックエンドを常駐起動し，以降はフロントを watch ビルドして `dist` を更新し続ける．UIを編集したらブラウザを再読込すれば反映される．

状態（IDLE/LISTENING/THINKING/SPEAKING）に応じて，谺のロゴとUIエージェント（2Dの「こだまの精」アバター）がリアルタイムに反応する．バックエンドの `/ws` へWebSocketで接続する．

> 一度ビルドして起動するだけ（watch不要）なら `npm run up`（= `build:web` → `serve`）．Electronのデスクトップ窓で開くなら `npm run app`．

### 設定画面（音声デバイスの切り替え・テスト）

右上の ⚙ から設定画面を開き，**マイク（入力）とスピーカー（出力）を一覧から切り替え**られる．切り替えた直後にその場でテストできる．

- **入力テスト**: 約1.5秒録音し，拾えた音量をメーターで表示する（マイクに話しかけて確認）．
- **出力テスト**: 選択中のスピーカーへテスト音（短いサイン波）を鳴らす．

入力は `avfoundation`，出力は `audiotoolbox`（CoreAudio）越しに ffmpeg が扱う．選んだデバイスはローカルDBに永続化され，次回起動時に復元される（REST: `/api/audio/*`）．

## 記憶・学習・画面（語彙／要約／横断参照／生成UI）

谺は会話を重ねるほど賢くなり，蓄積から答え，必要なら画面でも応える（設計は [DESIGN.md §15](./DESIGN.md) を参照）．

- **語彙学習**: 教わった固有名詞・専門語・人名を語彙として覚え（`learn_term`／「◯◯は私のプロジェクト」等で起動），以後の常時STT（whisper）の認識ヒントへ動的に載せて聞き取り精度を底上げする．読みを伴う登録（`register_reading`）は発音辞書にも反映される．会話から繰り返し現れる語は要約時に自動でも語彙化する．
- **会話の定期要約**: バックグラウンドジョブが一定間隔で会話を「同じ話題のかたまり（トピック）」へ畳み込み，要約をローカルDBに保存する．継続中の話題は既存トピックへマージし，セッション終了時には全体要約も残す．
- **DB横断参照**: 「前に話したよね」「あの件」のような参照では，過去会話・トピック要約・長期メモ・語彙を横断検索（`search_history`）してDB内のすべてから想起する．
- **生成UIと実ブラウザ**: 一覧・表・比較・フォームなど音声では伝えにくい情報は，その場でHTML/CSSを生成しサンドボックスのパネルに描画する（`render_ui`，対話可能にもできる）．Web検索結果や参照ページは実ブラウザ（デスクトップ版は既定ブラウザ）で開いて操作できる（`open_url`）．
- **話者識別（声による個人識別）**: 発話ごとに話者埋め込み（sherpa-onnx + CAM++，完全ローカル）を計算し，登録済みの声と照合して発話に（話者: 名前）タグを付ける．未登録の声は「ゲストA」等の仮ラベルで扱われ，谺が会話の流れで名前を尋ねて `enroll_speaker` で声ごと登録する（＝声を覚える）．以後はその人を声で識別し名前で応対する（`list_speakers`／`rename_speaker`／`forget_speaker` で管理，`SPEAKER_*` で調整）．

これらのデータは右上の ⚙ や REST（`/api/terms`・`/api/topics`・`/api/search`）からも参照・管理できる．会話・要約・語彙はすべてローカルに保持し，クラウドには残さない．

## 前提

- Node.js 20+
- **ffmpeg / ffplay**（マイク取り込みと音声再生に使用）: `brew install ffmpeg`
- APIキー: Anthropic（頭脳）と OpenAI（耳と声）
- **whisper.cpp**（常時ローカルSTT＋ウェイクワード）: `brew install whisper-cpp`（`whisper-server` / `whisper-cli` を使用）
  - 常時ストリーミング用モデルを `models/` に配置（最高精度構成）:
    ```bash
    curl -L -o models/ggml-large-v3.bin       https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin
    curl -L -o models/ggml-large-v3-turbo.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
    ```
  - ウェイクワード/バージイン照合用に軽量モデル（`WHISPER_MODEL=./models/ggml-small.bin`）も併用
- **話者識別モデル**（声による個人識別，任意）: `models/` に話者埋め込みモデルを配置（無ければ話者識別だけ無効）:
  ```bash
  curl -L -o models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx \
    https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx
  ```
- **人物検出モデル**（在室検知の補助，任意）: YOLOX-tiny を `models/` に配置（無ければフレーム差分の動き検知のみで在室判定）:
  ```bash
  curl -L -o models/yolox_tiny.onnx \
    https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx
  ```
- 任意: IPカメラのRTSP URL（在室検知）

## セットアップ

```bash
npm install
cp .env.example .env   # ANTHROPIC_API_KEY と OPENAI_API_KEY を記入
```

> Node を更新したあとに `NODE_MODULE_VERSION ... requires ...`（better-sqlite3 のABI不一致）で起動に失敗する場合は，現行 Node 向けにネイティブモジュールを再ビルドする．
> ```bash
> npm run rebuild:native
> ```
> （node-gyp 用に distutils 互換の Python venv を `~/.kodama-build/py` に自動用意してから `better-sqlite3` を再コンパイルする．）

## Phase 0 の疎通確認

Claude・OpenAI・ローカルストレージが動くか確認する．

```bash
npm run check:apis
```

成功すると，Claudeの短い応答とTTS音声が `DATA_DIR/audio/` 配下に生成される．

## 起動（デスクトップアプリ）

コマンド1つで，フロントエンドをビルド → バックエンド常駐を自動起動 → デスクトップウィンドウを開く．

```bash
npm run app      # = npm start．Electron アプリが起動し，谺のUIが立ち上がる
```

`npm run app` は次を自動で行う．フロントエンドを事前ビルド（`packages/frontend/dist`）し，Electron がバックエンド（`http://localhost:52525`）を子プロセスとして起動，`/health` の応答を待ってから，**バックエンドが一体ホストする** Web UI をウィンドウに表示する．別オリジン・別プロセスのフロント開発サーバは不要．

> 初回はマイク使用許可を求められる場合がある（システム設定 → プライバシーとセキュリティ → マイク で許可）．

### 開発モード（ホットリロード）

UIを編集しながら開発する場合も **1コマンド** で済む．

```bash
npm run dev      # フロント watch ビルド ＋ バックエンド常駐を同時起動（http://localhost:52525）
```

`scripts/dev.mjs` がフロントを初回ビルド→バックエンドを `tsx watch` で常駐→フロントを `vite build --watch` で監視，の順に立ち上げる．バックエンドのソース変更は自動再起動，UIの変更は `dist` が再ビルドされるのでブラウザ再読込で反映される．Ctrl-C で両方とも停止する．

別々のプロセスで動かしたい場合は従来どおり `npm run dev:backend` と `npm run dev:web`（Vite開発サーバ http://localhost:5173, `/ws` を 52525 へプロキシ）も使える．

### Macアプリとして配布（.dmg）

```bash
npm run dist     # electron-builder で .dmg を生成（packages/desktop/release）
```

> 配布パッケージはバックエンドの事前コンパイル（`packages/backend/dist`）とネイティブモジュール（better-sqlite3）のElectron ABI向け再ビルドを前提とする．`brew install ffmpeg whisper-cpp` 等の外部バイナリは利用者環境に必要（同梱しない）．署名・公証は別途設定する．
>
> **常時文字起こし／ウェイクワード**には whisper.cpp（`whisper-cli`）と ggml モデルが必要．モデル（`models/ggml-small.bin` 等）は `build.sh` 実行時に `.app` へ同梱され（`extraResources`），`WHISPER_MODEL` の相対パスは実行ディレクトリ基準で絶対化されるため，dev・パッケージ版の双方で解決される．`.app` は Dropbox 配下から起動するとファイルが退避され不安定になるため，`/Applications` 等 Dropbox 外から起動すること．

## 話しかける

- **音声（完全常時）**: `LOCAL_STREAMING=1` のとき，**ウェイクワード不要**で常時マイクを聞き続ける．話すと途中経過がライブ表示され（large-v3-turbo），言い終えると確定（large-v3）する．音声はクラウドへ送らない．
  - `LOCAL_STREAMING=0` の場合は従来のウェイクワード起動方式（「こだま」で起動 → 話す → 返答）．
- **応答ゲート（`ADDRESSING_GATE=1`）**: 常時聞き取った発話は**すべて履歴に残す**が，**谺へ明確に向けられた発話だけ**に応答する．複数人の会話・独り言・谺宛でない雑談には黙って聞くだけ（呼びかけ「こだま」や，谺との対話の自然な続きは応答対象）．テキスト入力と手動ウェイク直後は明示依頼として必ず応答する．回答時はゲートが内容から適切な履歴範囲（`CONTEXT_WINDOW_*`）を判断して遡る．
- **発話を止める／割り込む（バージイン）**: 谺の発話・思考中は，画面の「■ 停止」ボタン，音声で「**ストップ**／止まって／やめて」等（`STOP_PHRASES`），または **`BARGE_IN=1` ならフレーズ無しでも話し始めるだけで即中断**して傾聴へ切り替わる（語頭も取りこぼさず引き継ぐ）．生成自体も止まる．
  - エコーキャンセル無しのため，**スピーカー使用で谺が自分の声に反応して自己中断する場合**は `BARGE_IN=0` にするか `BARGE_THRESHOLD_MULT` を上げる（ヘッドホン推奨）．逆に自分の声で止まらないときは値を下げる．
- **テキスト**: Web UI下部の入力欄から送信．マイク無しでも頭脳＋音声合成の全経路を駆動でき，谺がスピーカーから話す．UIの3Dエージェントは状態に同期して反応する．
- **手動ウェイク**: Web UIの「谺」ボタン（「こだま」と呼ぶのと同じ）．

## 実装状況

全フェーズ実装済み（実機での音声・カメラ動作はマイク/カメラ/各キーの接続が前提）.

- [x] 環境準備・API疎通（`npm run check:apis`）
- [x] 音声往復ループ（マイク → ウェイクワード → VAD → STT → Claude → TTS → 再生）
- [x] Web UI（WebSocketで状態可視化・動くロゴ・3D UIエージェント・テキスト対話）
- [x] レイテンシ最適化（文単位の投機的TTS・再生キュー・バージイン）
- [x] 完全ローカルの常時ストリーミングSTT（whisper-server 常駐：ウェイク不要・途中経過(large-v3-turbo)＋確定(large-v3)・擬似ストリーミング．`LOCAL_STREAMING=1`）
- [x] 応答ゲート（全発話を履歴に残しつつ谺宛の発話だけに応答／文脈範囲を自動判断．`ADDRESSING_GATE=1`）と発話中の停止（UIボタン＋音声「ストップ」＋生成キャンセル）
- [x] カメラ在室検知（RTSP + フレーム差分．ONNX人物検出へ差し替え可能）
- [x] 人格と記憶（会話履歴・長期メモ・設定永続化）．**名前・主人・呼び方は任意設定**（`.env` の `ASSISTANT_NAME`/`OWNER_NAME` 等, または会話で「君の名前を〇〇にして」＝`set_identity` ツール）．回答量は内容に応じて自動調整（既定はコンパクト, 必要時のみ詳細）
- [x] ツール連携の枠組み（Claude tool use: 時刻・在室・記憶・想起のローカルツール）
- [x] Web検索（Anthropic公式のサーバサイドツール．最新情報・事実確認を引用付きで回答．`WEB_SEARCH=1`）
- [x] 即応発話（最初の一文が確定した瞬間に話し始める．`TTS_FIRST_MIN_CHARS`．以降は `TTS_MIN_CHARS` 単位で文をまとめてなめらかに読み上げる）
- [x] 自己改修（谺が**承認制**で自分自身のソースコードを書き換える．会話で機能追加を提案→主人の承認→変更ステージ→隔離コピーで型検査→適用→自動再起動→**会話は履歴を引き継いで継続**．起動失敗時は監督プロセス `scripts/serve-forever.mjs` がバックアップから自動で巻き戻し，谺が失敗を口頭報告する．`SELF_MOD=1`．`npm run serve`／`npm run app`／`npm run dev` のいずれでも再起動が機能する）

### 今後の拡張余地

- 音響エコーキャンセルでマイク経由バージインを安定化
- 外部サービスツール（カレンダー・メール・Notion・論文参照）を `brain/tools.ts` に追加
- ウェイクワードの精度向上（whisperモデルの大型化や専用キーワード検出への差し替え）
- カメラの在室検知をONNX人物検出へ（精度向上）
