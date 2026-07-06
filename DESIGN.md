# 谺（kodama）— 研究室据え付け型AI秘書 設計書

> 名称: **谺（kodama）**．声を受けて返す「こだま・反響」に由来する．Web UIには反応するロゴとUIエージェント（アバター）を備える．

最終更新: 2026-06-27

## 1. ゴールと体験コンセプト

研究居室に据え付け，マイクとIPカメラで室内を常時モニタリングし，呼びかけ（ウェイクワード）を契機に会話を開始する音声AI秘書を構築する．入力音声をリアルタイムに文字へ整形し，Claude APIに渡して応答を生成し，OpenAIの音声合成で人間と見紛う流暢さの音声に変換して返答する．加えて，ブラウザからアクセスできるWebインタフェースを持つ．

人格の方向性は **「有能で簡潔な秘書」** とする．敬語ベースで無駄なく的確に応答し，研究タスクの補助に最適化する．映画『ブレードランナー2049』のジョイが持つ「部屋に宿る存在感」は演出として取り込みつつ，過剰な情緒表現には寄せない．

体験上の最重要指標は **沈黙の短さ（応答レイテンシ）** と **声の自然さ** の二点であり，この二つの掛け算で「本物らしさ」が決まる．

## 2. 実装言語と全体方針: TypeScript で統一したWebシステム

本システムは **クライアント・サーバ型のWebシステム** として構築する．バックエンド常駐サービスとブラウザのフロントエンドを，いずれも **TypeScript** で実装し，言語をひとつに統一する．

言語選定の根拠は計算速度ではない．ローカル側の処理は音声ストリームの取り回しとクラウドAPIの中継という **I/Oバウンドな仕事** であり，重い計算（STT・LLM・TTS）はすべてクラウドが担うため，ローカル言語の計算速度はボトルネックにならない．むしろWebインタフェースを持つ以上，フロントとバックを同一言語・同一型定義で貫けることの保守上の利益が大きく，TypeScriptが最適となる．

ランタイムは Node.js（LTS）を基本とする（高速起動を求めるならBunも選択肢）．唯一JS生態系が薄いのはカメラ映像処理であり，これは外部プロセス（ffmpeg）とONNX推論で補う（後述）．

## 3. アーキテクチャ上の中核判断: Claude頭脳 + OpenAI音声のパイプライン

生成AIの頭脳は原則Claude APIで処理する．一方で音声合成（TTS）の部分だけ局所的にOpenAI APIを用いる．OpenAIの音声合成はLLMとは独立した専用エンドポイント（gpt-4o-mini-tts系）であり，Claudeが生成したテキストをそのまま流し込んで音声化できる．

この構成は「STT（音声→文字）→ Claude（応答生成）→ OpenAI TTS（文字→音声）」の3段パイプラインとなる．Claudeには音声を直接やり取りするネイティブのリアルタイム音声APIが存在しないため，各段を自前でオーケストレーションする必要があるが，その代わり各段を最良の実装に差し替えられる柔軟性が得られる．レイテンシは各段の足し算になるため，全段をストリーミングで連結することが自然さの生命線となる．

外部ベンダは Anthropic（頭脳）と OpenAI（耳と声）の二社に集約する．STTもOpenAI側（gpt-4o-transcribe系）に寄せることで，外部依存を二社に収め，鍵管理と運用を簡潔にする．

## 4. 全体アーキテクチャ

母艦は **Mac (Apple Silicon)** とし，バックエンド常駐サービスをここで動かす．配置は **ハイブリッド** とする．プライバシーとコストに直結するウェイクワード検知と在室検知はローカルで完結させ，会話本体はウェイクワード検知後にのみクラウドへ送る．ブラウザのWeb UIはバックエンドとWebSocket/HTTPで通信し，状態監視・設定・会話履歴の閲覧と，補助的な対話クライアントを担う．

```
┌──────────────────────────┐        ┌──────────────────────────────┐
│  ブラウザ Web UI (TS/SPA)   │        │  クラウド (起動後のみ)          │
│  ・稼働状況/在室の可視化     │        │   STT  (OpenAI gpt-4o-transcribe)│
│  ・設定/人格/声の調整        │        │   頭脳 (Claude API)             │
│  ・会話履歴の閲覧           │        │   TTS  (OpenAI gpt-4o-mini-tts) │
│  ・補助的なテキスト/音声対話 │        └───────────────▲──────────────┘
└───────────┬──────────────┘                        │
            │ WebSocket / HTTP                       │ 起動後のみ送出
            ▼                                        │
┌────────────────────────────────────────────────────┴───────┐
│  母艦: Mac (Apple Silicon)  バックエンド常駐サービス (Node/TS)  │
│                                                              │
│  [ローカル / 常時]                                            │
│   ① 在室検知    (ffmpeg + ONNX人物検知)                       │
│   ② ウェイクワード(ローカル Whisper / whisper.cpp)            │
│   VAD 発話終端  (Silero / onnxruntime-node)                  │
│   音声入出力    (マイク取り込み・スピーカー再生)               │
│   オーケストレータ・状態機械                                   │
└──────────────────────────────────────────────────────────────┘
        ▲ RTSP(映像/音声)              ▲ USB音声
        │                             │
   IPカメラ(Blurams A31)        マイクアレイ(ReSpeaker等)
```

ウェイクワード検知をローカルに残すのは，常時音声をクラウドへ送り続けないためであり，プライバシーとコストの両面で必須の判断となる．在室検知（カメラ）は「人がいる時だけ起動を許す」「振り向いて話しかけたら反応する」といった演出と省コストに用いる．

据え付け本体（アプライアンス）はヘッドレスのバックエンドとして常時稼働し，マイク・スピーカーを直接握る．Web UIはその「窓」であり，手元のPCやスマホから状態を見たり，テキストで指示を出したりする補助経路となる．ブラウザ側でマイク/再生を扱う対話モード（Web Audio API利用）も選択肢として残す．

## 5. 処理フローとレイテンシ予算

人間が「即座に返ってきた」と感じる境界は，発話の言い終わりからおおむね700ms〜1秒である．パイプライン各段の完了を待たず，前段の部分結果が出た瞬間に次段へ流し込む投機的パイプライン化で，体感の初音到達を1秒前後へ圧縮する．

| 段 | 処理 | 目標レイテンシ | 鍵 |
|---|---|---|---|
| ② ウェイクワード | 「こだま」を検知 | 区間ごと数百ms(ローカル) | VADで切り出しローカルWhisperで照合．クラウドに送らない |
| VAD | 発話終端の判定 | 200〜400ms | 無音検知で区切る |
| ③ STT | 音声→文字 | 確定まで0.3〜0.8s | 部分文字起こしを逐次Claudeへ |
| ④ Claude | 応答生成 | 初トークンまで0.5〜1s | streaming必須 |
| ⑤ TTS | 文字→音声 | 初音まで0.2〜0.5s | 文単位で逐次合成・再生 |

状態機械は以下の4状態とする．

```
IDLE ──(ウェイクワード)──▶ LISTENING ──(発話終端)──▶ THINKING ──(初トークン)──▶ SPEAKING
  ▲                                                                              │
  └────────────────────(発話完了 / タイムアウト)──────────────────────────────────┘
```

最重要の最適化は段の連結である．STTの部分文字起こしが出た瞬間にClaudeへ投機的に流し始め，Claudeの最初の一文（句点区切り）が出た瞬間にOpenAI TTSへ送って喋り始める．バージイン（SPEAKING中にユーザが話し始めたら再生停止しLISTENINGへ戻る）はローカルVADで検知して処理する．状態遷移と各イベントはWebSocket経由でWeb UIにも配信し，画面上でリアルタイムに可視化する．

## 6. モジュール構成（TypeScript / モノレポ）

ワークスペース（npm workspaces / pnpm）でバックエンドとフロントを同居させ，型定義を共有する．

```
packages/
  shared/          # 共有の型定義（イベント・状態・メッセージスキーマ）
  backend/         # 常駐サービス (Node/TS)
    perception/
      camera.ts       # ffmpegでRTSP取得 → ONNX人物検知 → 在室イベント
      wakeword.ts     # VADで切り出し→ローカルWhisperで照合→起動トリガ
    audio/
      capture.ts      # マイク取り込み + Silero VADで発話区間切り出し
      playback.ts     # 音声チャンクの逐次再生・バージイン即停止
    stt/openaiStt.ts    # OpenAI STT (gpt-4o-transcribe) ストリーミング
    stt/localWhisper.ts # ローカル Whisper (whisper.cpp CLI) ウェイクワード照合用
    brain/claudeClient.ts # Claude API ストリーミング・人格・履歴・tool use
    tts/openaiTts.ts  # OpenAI TTS (gpt-4o-mini-tts) ストリーミング
    core/
      stateMachine.ts # IDLE/LISTENING/THINKING/SPEAKING
      orchestrator.ts # 全体を束ねるイベントループ
    server/
      httpApi.ts      # 設定・履歴のREST
      wsGateway.ts    # Web UIへの状態配信・対話中継 (WebSocket)
      （index.ts が @fastify/static でビルド済みフロントを一体ホスト）
    tools/            # Claude tool useで呼ばれる秘書機能
    memory/store.ts   # 会話履歴の短期保持と長期メモ永続化
  frontend/        # ブラウザ Web UI (TS + Vite + React)．build で dist を生成しバックエンドが配信
    dashboard/      # 稼働状況・在室・状態機械の可視化
    settings/       # 人格・声・ウェイクワード等の設定
    history/        # 会話履歴の閲覧・検索
    chat/           # 補助的なテキスト/音声対話クライアント
  desktop/         # Electron デスクトップアプリ
    main.cjs        # バックエンドを子プロセス起動→/health待ち→ウィンドウ表示
```

配備形態は，フロントを事前ビルドしてバックエンドが同一オリジンで一体ホストし（別フロントサーバ不要），Electron がそのバックエンドを常駐子プロセスとして自動起動してウィンドウに表示する，単一アプリ構成とする．`npm run app` の1コマンドで（フロントのビルド→常駐起動→ウィンドウ表示まで）立ち上がる．

## 7. 技術選定（確定）

| 役割 | 採用 | 理由 |
|---|---|---|
| 言語 | TypeScript（フロント・バック共通） | Webと一本化，型共有，保守性 |
| バックエンド実行系 | Node.js LTS（Bunも可） | I/Oバウンド処理に十分，生態系が厚い |
| Webサーバ | Fastify + ws (WebSocket) | 軽量・高速・リアルタイム配信向き |
| フロントエンド | Vite + React（またはSvelte） | リアルタイムダッシュボードを素早く構築 |
| ウェイクワード | ローカル Whisper (whisper.cpp CLI) | 完全ローカル・APIキー不要・任意の日本語フレーズを照合可 |
| VAD | Silero VAD (onnxruntime-node) | 軽量・高精度な発話区間検出 |
| 在室/人物検知 | ffmpeg(RTSP) + ONNX人物検出 | JS生態系の薄い視覚処理をONNXで補う |
| マイク | ReSpeaker Mic Array (USB) | 遠距離音声に強い．カメラ内蔵マイクは補助 |
| STT | OpenAI gpt-4o-transcribe | ストリーミング文字起こし．ベンダをOpenAIに集約 |
| 頭脳(LLM) | Claude API (@anthropic-ai/sdk, streaming) | 原則ここで処理．2段構え（軽量/重い依頼） |
| TTS | OpenAI gpt-4o-mini-tts (openai SDK) | 局所的にOpenAI．自然・低遅延・口調指示可 |
| 音声再生 | speaker / ffplay | 低レイテンシなチャンク再生 |

代替・退路として，OpenAI TTSの日本語自然さが不足する場合はElevenLabs（日本語）へ差し替え，視覚処理が困難な場合は在室検知だけを独立した軽量ワーカ（言語非依存）に切り出す．各モジュールはインタフェースで分離し交換可能にする．

## 8. Webインタフェースの役割

Web UIは据え付け本体の制御盤かつ補助クライアントとして以下を担う．

- 稼働状況・在室状態・状態機械（IDLE/LISTENING/…）のリアルタイム可視化
- 人格（口調・モード）・声（話者・トーン指示）・ウェイクワード・感度などの設定
- 会話履歴の閲覧・検索・長期メモの管理
- 手元のPCやスマホからのテキスト指示，必要に応じてブラウザマイクでの音声対話
- コスト・使用量のモニタリング

バックエンドとはWebSocketで状態を双方向同期し，RESTで設定と履歴を扱う．

## 8.5 データ永続化（ローカルサーバ完結）

会話履歴・文字起こし・音声データ・長期メモ・使用量ログは，すべて母艦（ローカルサーバ）に永続化し，クラウドには保持しない．クラウドは会話の一巡の間だけ音声・テキストを処理する経路であり，データの恒久的な置き場はあくまでローカルである．

- 構造化データ（セッション・メッセージ・文字起こし・長期メモ・使用量）は組み込みDB（SQLite / better-sqlite3）に格納する．単一ノードのアプライアンスに最適で，外部DBサーバを要しない．
- 音声データ（ユーザ発話の録音とTTS出力）はローカルディスク上にファイルとして保存し，DBのレコードからパス参照する．セッション単位でディレクトリを分ける．
- データ格納先は `DATA_DIR`（既定 `./data`）以下に集約し，バックアップ・移行を一括で扱えるようにする．
- 将来の検索・想起のため，長期メモは全文検索（およびオプションでローカル埋め込み）に対応できる構造にしておく．

これにより「全部ローカルに持つ」要件を満たし，プライバシーとデータ主権を確保する．

## 9. 人格・声の設計

Claudeのシステムプロンプトで人格を規定する．

- 役割: 研究居室に常駐する有能な秘書．油谷知岐の研究タスク補助に最適化．
- 口調: 敬語ベース，簡潔，結論から述べる．冗長な前置きを避ける．
- 出力テキスト: 句点「．」読点「，」を用いる（ユーザの文章スタイル準拠）．TTSへ渡す際も自然な区切りになる．
- 振る舞い: 不確かなことは確認を返す．要点を先に，詳細は後に．

声はOpenAI TTSの話者から落ち着いた知的なものを選定し，gpt-4o-mini-ttsの口調指示で「落ち着いた・簡潔・知的」なトーンを与える．感情過多に寄せず明瞭さを優先する．人格と声の指示はWeb UIから調整できるようパラメータ化する．

## 10. 拡張: ツール連携（Claude tool use・将来）

Claudeのtool useで，秘書から外部サービスを操作する．本環境で既に接続のあるものを優先する．

- カレンダー（Google Calendar）の予定確認・登録
- メール（Gmail）の確認・下書き
- ノート（Notion）への記録・検索
- 油谷の論文資料（myfiles）の参照
- 室内状況（在室・時刻）のコンテキスト注入

## 11. コスト試算（概算・要検証）

従量課金の主因は STT（OpenAI）・LLM（Claude）・TTS（OpenAI）の三つである．1日あたり実会話10分・応答テキスト計5000字と仮定した粗い見積りは契約単価確定時に再計算する（現時点では未確定事項）．コスト最適化として，ウェイクワード起動・在室連動で送出を必要最小限に限定する．使用量はWeb UIで可視化する．

## 12. 実装ロードマップ

カメラ込みフル構成を目標としつつ，動く最小経路から積み上げる．

1. **Phase 0 — 環境準備**: TypeScriptモノレポ雛形（backend/frontend/shared），依存管理，APIキー管理（.env: Anthropic / OpenAI），各API疎通確認．
2. **Phase 1 — 音声往復の最小ループ**: マイク → ウェイクワード → VAD → OpenAI STT → Claude → OpenAI TTS → 再生．カメラ抜きで会話を成立させる．
3. **Phase 2 — Web UIの土台**: WebSocketで状態配信，ダッシュボードで状態機械と会話をリアルタイム可視化．
4. **Phase 3 — レイテンシ最適化**: 全段ストリーミング化と投機的パイプライン化．バージイン対応．
5. **Phase 4 — カメラ統合**: Blurams A31のRTSP取り込み，ONNX人物検知，在室時のみ起動する制御．
6. **Phase 5 — 人格と記憶**: システムプロンプト人格，会話履歴，長期メモ，Web UIからの設定．
7. **Phase 6 — ツール連携**: カレンダー／メール／Notion／論文資料との接続．

## 13. リスク・未確定事項

- **Blurams A31のRTSP対応可否**: 多くのBluramsはRTSP対応だが，A31の対応有無は実機確認が必要．非対応ならONVIF経由かメーカSDK，最悪は別のRTSP対応IPカメラへ変更を検討．
- **Node生態系の視覚処理の薄さ**: 在室検知はffmpeg＋ONNXで補うが，難航時は視覚処理だけ独立ワーカ（言語非依存）に切り出す．
- **音声I/Oのネイティブ依存**: Nodeでのマイク取り込み・再生はネイティブモジュール（speaker等）またはffmpeg/sox子プロセスに依存する．環境差異に注意．
- **OpenAI TTSの日本語自然さ**: 「人間と見紛う」水準に達するか実音声で要評価．不足時はElevenLabsへ差し替え．
- **パイプライン遅延**: 3段の足し算を投機的パイプラインで吸収できるかがPhase 3の焦点．
- **マイク品質**: 遠距離・残響のある居室では誤検知・取りこぼしが起きやすい．マイクアレイ導入を前提とする．
- **常時稼働の安定性**: 長時間稼働でのAPI切断・再接続・メモリリークに備えた監視と自動復帰を入れる．
- **プライバシーとデータ主権**: 会話履歴・音声・メモはすべてローカルサーバに保持し（§8.5），クラウドへは起動後の必要最小限の送出に限定する．録音・録画の保持期間と削除方針はWeb UIから管理する．

## 14. 実装状況（2026-06-15時点）

全フェーズの実装が完了し，全パッケージが型チェック・ビルドを通る．ローカル完結部（SQLiteストレージ・WAV生成・エネルギーVAD・文分割）は自己診断テストで動作確認済み．バックエンドはダミーキーで起動確認済み（HTTP/WS応答・人格ロード）．マイク・カメラ・実APIを使う経路は，ffmpeg・各APIキー・RTSP URLの接続を前提に動作する．

- 知覚: ウェイクワード（ローカルWhisper/whisper.cpp, optional・VADで切り出し照合・未設定時は手動ウェイクへフォールバック），カメラ在室検知（ffmpegフレーム差分）
- 音声I/O: ffmpeg取り込み（16kHz/mono）＋ffplay再生（バージインで即停止）
- パイプライン: エネルギーVADで発話切り出し → OpenAI STT → Claude（tool use対応のエージェントループ）→ 文単位の投機的TTS → 逐次再生
- Web UI: 状態のリアルタイム可視化，動くロゴ，3D UIエージェント，テキスト対話
- データ: 会話・音声・長期メモ・設定をローカルに永続化（クラウドに残さない）

テスト経路として，マイク無しでもWeb UIのテキスト入力から頭脳＋音声合成の全経路を駆動できる．
```

## 15. 追加設計: 語彙学習・会話要約・DB横断参照・生成UI（2026-06-27）

谺をより「自分の研究文脈を知り，蓄積から答え，画面でも応える秘書」へ育てるための4機能を設計する．いずれも既存アーキテクチャ（SQLiteローカル永続化・Claude tool use・WebSocket配信）の延長線に無理なく載り，クラウドへデータを残さない原則（§8.5）も保つ．現状のコードには一部の土台（発音辞書・`sessions.summary`列・`recall`）が既にあり，本設計はそれらを「実際に効く配線」「自動学習」「全データ参照」「画面生成」へ接続するものである．

4機能は独立に見えて，実は一本の流れで結ばれる．会話を聞き取る入口の精度を語彙学習で底上げし，聞き取った会話を定期要約で話題のかたまりへ畳み込み，畳み込んだ蓄積を横断検索で想起に供し，想起した結果を音声だけでなく生成UIで画面にも返す——入力から記憶，記憶から出力までを一巡させる設計とする．

### 15.1 語彙学習による認識強化

現状，固有名詞の登録経路（`register_reading`ツール → `Lexicon`）は存在し，`Lexicon.sttHint()`が表記をwhisperのpromptへ渡して綴りを誘導する仕組みまで書かれている．ところがこのヒントが効くのは一括認識のフォールバック経路（`orchestrator.ts`の`onUtterance`）だけで，主経路である常時ストリーミングSTT（`LocalStreamingStt`）はprompt無しで生成されており，登録語が主たる認識精度に反映されていない．さらに「読み」を持たない一般の専門用語・プロジェクト名を貯める器がなく，会話から自動的に語彙を覚える仕組みもない．ここを埋める．

語彙は読み（TTS用）と区別して，認識バイアス用の独立テーブルに持つ．

```sql
CREATE TABLE terms (
  id          TEXT PRIMARY KEY,
  surface     TEXT NOT NULL,            -- 表記（whisperヒント／検索キー）
  reading     TEXT,                     -- 読み（あれば発音辞書へも反映）
  aliases     TEXT,                     -- 異表記・誤認識されやすい綴り（JSON配列）
  kind        TEXT NOT NULL,            -- person | project | jargon | place | other
  weight      REAL NOT NULL DEFAULT 1,  -- ヒント優先度（出現頻度×新しさで増減）
  source      TEXT NOT NULL,            -- user（明示）| auto（自動抽出）
  hit_count   INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_terms_surface ON terms(surface);
```

認識への配線は，`WhisperServer.transcribe`がリクエスト毎に`prompt`フィールドを受け付けられる点を使う（whisper.cppの`/inference`はper-request promptに対応するが，現状の`transcribe`は送っていない）．`transcribe(wav, prompt?)`へ拡張し，`LocalStreamingStt`は確定・途中の各推論時に「現在の語彙ヒント」を動的に差し込む．ヒント文字列は`weight`の高い順に上位N語（whisperのprompt長は約224トークン上限のため`config.sttHintMaxTerms`で打ち切る）を`固有名詞: …．`の形で並べ，既存`Lexicon.sttHint()`と統合する．辞書更新時はサーバ再起動が要らず，次の推論から即座に効く．読み付きエントリは従来どおり`Lexicon`へも入れTTSの読み崩れを防ぐ．

自動学習は二段構えとする．ユーザが明示的に教えた語（「『谺』は『こだま』」「〇〇というのは……」のような定義発話）は`source=user`・`active=1`で即登録する．それとは別に，定期要約ジョブ（§15.2）が話題を畳み込む際に，繰り返し現れる未知の固有名詞・専門語を`source=auto`・低`weight`で候補登録し，`hit_count`が閾値を超えたら`active=1`へ昇格させる．自動登録語は誤抽出が混じり得るため，設定画面（§15.4のUI／既存の発音辞書UIの隣）で一覧・編集・無効化できるようにし，谺が勝手に覚えた語をユーザが監督できる状態を保つ．

ツールは既存`register_reading`を「読み登録＋term登録」に拡張し，読み不要の語彙のために`learn_term(surface, reading?, kind, aliases?)`を追加する．システムプロンプトには「教わった用語・人名・プロジェクト名は`learn_term`で覚える」一文を足す．

### 15.2 会話の定期要約とトピック化

`sessions.summary`列は用意されているのに`endSession`へ要約が渡されておらず，要約は一度も生成されていない．話題でまとめる構造も無い．会話を「同じ内容のかたまり＝トピック」へ畳み込んで保存する仕組みを足す．

```sql
CREATE TABLE topics (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,            -- 話題の見出し
  summary     TEXT NOT NULL,            -- 要約本文
  keywords    TEXT,                     -- 主要語（JSON配列・検索とterms候補に使う）
  salience    REAL NOT NULL DEFAULT 1,  -- 重要度（言及量・新しさ）
  started_at  TEXT NOT NULL,
  ended_at    TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE topic_messages (        -- トピックと元メッセージの対応（出典追跡）
  topic_id    TEXT NOT NULL REFERENCES topics(id),
  message_id  TEXT NOT NULL REFERENCES messages(id),
  PRIMARY KEY (topic_id, message_id)
);
```

要約は常駐のバックグラウンドジョブ（`TopicDigester`）が担う．未要約メッセージの水位線（`settings`に`lastDigestedAt`として保持）以降を読み，三つの契機——会話の区切り（一定時間の無音）・セッション終了・一定間隔のタイマー——のいずれかで起動する．既に要約済みの直近トピック見出しを文脈として渡した上で，`config.fastModel`に未要約メッセージを話題ごとに分割・要約させ，継続中の話題には既存トピックへマージ（`summary`更新・`topic_messages`追記・`ended_at`/`salience`更新），新規話題は挿入する．水位線を進めることで再処理とコスト膨張を防ぎ，メッセージが無いときは何もしない．併せて`endSession`時にそのセッションの要約を`sessions.summary`へ書く．抽出された`keywords`のうち未知の固有名詞は§15.1の自動語彙候補へ流す．

### 15.3 DB全データの横断参照

現状，谺が想起に使える`recall`は`memories`テーブルのLIKE検索だけで，過去の会話本体（`messages`）・セッション要約・トピック要約・語彙には手が届かない．「DB内すべてを参照して答える」には届いていない．SQLiteのFTS5で全データを横断検索できるようにする．

`messages`・`topics`・`memories`・`terms`を対象に，content-linkなFTS5仮想テーブルを張り，トリガで本体テーブルと同期させる（既存データは初回マイグレーションでバックフィル）．日本語はトークナイズが課題のため，`unicode61`に加えてバイグラム分割を併用し，部分一致の取りこぼしを抑える．`Store.searchAll(query, scope?)`が各ソースを横断して，種別タグ・スニペット・日時・関連度で順位付けした結果を返す．

ツールは`search_history(query, scope?)`を追加し，過去会話・トピック要約・長期メモ・語彙を一括で引けるようにする（`scope`で会話のみ／要約のみ等に絞れる）．`recall`は長期メモ専用として残しつつ，システムプロンプトで使い分けを与える——「以前の会話や前に話した話題は`search_history`，明示的に覚えた事実・指示は`recall`」．これにより「前にこの話したよね」「あの件どうなった」に，会話ログとトピック要約の両面から答えられる．参照対象は全てローカルDBに閉じ，§8.5の原則は不変である．

### 15.4 生成UI（Claudeが組む画面でのインタラクト）

Web UI自体は既にあり，バックエンドが一体配信しElectron窓にも出る．足りないのは，Claudeが応答に合わせてその場で画面（表・カード・簡単なフォーム）を生成して見せる「生成UI」である．音声は流れて消えるため，一覧・比較・選択肢提示・予定表のような構造的な情報は画面で添えると効く．

サーバ→フロントのイベントに`ui_render { html, css?, title?, ttlMs? }`と`ui_clear`を追加し（`@kodama/shared`のイベントスキーマへ），ツール`render_ui(html, css?, title?)`をClaudeへ与える．`runTool`は`ToolContext`へ渡した`renderUi`コールバック（orchestratorの`broadcast`から配線）経由で当該イベントを送る．フロントはロゴ／アバターの脇に**サンドボックス化したiframe**（`srcdoc`にhtml＋cssを内包，`sandbox`属性で既定はスクリプト無効・同一オリジン遮断）でパネルを描画し，`ttlMs`経過で自動的に`ui_clear`する．

Claude生成HTMLは信頼境界の外として扱うため，安全側に倒す．既定はスクリプト無効の静的表示とし，サイズ上限・CSP・許可タグの制限をかける．フォームによる対話が要る場合に限り，iframeから`postMessage`で値を親へ返す制限付きチャネルを開き，親はそれを`ui_event`クライアントコマンドとして`handleUtterance`へ明示入力として流す．こうして「画面で選ぶ→谺が受けて続ける」という対話ループを，スクリプト全開放を避けつつ成立させる．設定画面には§15.1の語彙・自動学習語の監督UIも同居させる．

### 15.5 実装の触り所（着手時の地図）

| 機能 | 主な変更ファイル | 追加要素 |
|---|---|---|
| 15.1 語彙学習 | `memory/store.ts`, `stt/whisperServer.ts`, `stt/localStreamingStt.ts`, `tts/lexicon.ts`, `brain/tools.ts`, `core/orchestrator.ts` | `terms`表，per-request prompt，`learn_term`ツール，動的ヒント配線 |
| 15.2 定期要約 | `memory/store.ts`, 新規`core/topicDigester.ts`, `core/orchestrator.ts` | `topics`/`topic_messages`表，要約ジョブ，水位線，`endSession`要約 |
| 15.3 横断参照 | `memory/store.ts`, `brain/tools.ts`, `brain/claudeClient.ts` | FTS5仮想表＋トリガ，`searchAll`，`search_history`ツール |
| 15.4 生成UI | `shared/src/index.ts`, `brain/tools.ts`, `core/orchestrator.ts`, `frontend/`（パネル＋iframe） | `ui_render`/`ui_clear`/`ui_event`，`render_ui`ツール，サンドボックスパネル |

着手順は，入力→記憶→出力の流れに沿って 15.1 → 15.2 → 15.3 → 15.4 とするのが自然で，各段が次段の素材（語彙→要約→検索→表示）を供給する．いずれも動く最小実装から積み，既存の型チェック・ビルドを通しながら進める．

### 15.6 実装状況（2026-06-27 時点）

§15の4機能を実装し，全パッケージの型チェック（`npm run typecheck`）とフロントのビルドを通過した．ローカルDB部（`terms`・`topics`・`topic_messages`・横断検索）は一時DBに対する自己診断で動作確認済み（語彙のupsertとauto→user格上げ・重み順ヒント・有効/無効フィルタ・トピックのupsert・`searchAll`の会話/要約/語彙横断ヒット）．

- **15.1 語彙学習**: `terms`表＋`upsertTerm`/`termHintSurfaces`，`WhisperServer.transcribe`のper-request prompt対応，`LocalStreamingStt`への動的ヒント供給（`setHintProvider`），`register_reading`の語彙登録兼用と`learn_term`ツール，要約ジョブからの自動語彙抽出（source=auto・低weight）．REST `/api/terms`（一覧・登録・有効切替・削除）も追加．
- **15.2 定期要約**: `TopicDigester`（一定間隔＋セッション終了時フラッシュ），`ClaudeClient.digestTopics`/`summarizeSession`，水位線`lastDigestedAt`で再処理抑止，`sessions.summary`への要約保存．REST `/api/topics`．
- **15.3 横断参照**: `Store.searchAll`（会話・トピック・メモ・語彙をLIKEで横断し新しい順に統合）と`search_history`ツール，システムプロンプトでの`recall`との使い分け指示．REST `/api/search?q=`（trigram FTS5化は将来の最適化）．
- **15.4 生成UI**: `ui_render`/`ui_open_url`/`ui_clear`イベントと`ui_event`コマンド，`render_ui`/`open_url`ツール，フロントの`GenerativePanel`（サンドボックスiframe・interactive時のみスクリプト許可），`postMessage`→`ui_event`の対話ループ，`open_url`は実ブラウザ（Electronは`shell.openExternal`既設）で開く．

**堅牢化（2026-06-27 追補）**: `render_ui`はHTMLをツール入力として生成するため応答が長くなる．`max_tokens`が小さい（旧1024）とツール入力のJSONが途中で切れて壊れ，SDKの組み立てで例外＝未処理rejectionとなりNode既定でプロセスが落ちていた．`BRAIN_MAX_TOKENS`（既定8192）へ引き上げ，さらに応答ストリームの失敗は例外を投げずに打ち切り，`respond()`全体をtry/catchで保護し，プロセスにも`unhandledRejection`/`uncaughtException`のガードを入れて，どこで失敗しても常駐が落ちないようにした．

## 16. 追加設計: 即応発話・自己改修（2026-07-05）

### 16.1 即応発話（最初の一文で話し始める）

文単位の投機的TTS（`Sentencer`）は当初から存在したが，チャンク切り出しの閾値が一律`TTS_MIN_CHARS`（既定60字）だったため，秘書として推奨される簡潔な応答（大半が60字未満）では文末境界が閾値に届かず，結局`flush()`＝全文生成後にしか発話が始まらないという構造的な待ちが生じていた．体感の「全部考えてから話し出す」の正体はこれである．

対策として`Sentencer`に**初回チャンク専用の小さい閾値**`TTS_FIRST_MIN_CHARS`（既定6字）を導入した．最初の一文（「承知しました．」等の相槌を含む）が確定した瞬間にTTSへ流して発話を開始し，2チャンク目以降は従来どおり`TTS_MIN_CHARS`で文をまとめて韻律の滑らかさを保つ．合成は投機的に並列開始・再生は順序どおりという既存の再生キューはそのまま活かしている．

### 16.2 自己改修（承認制の自書き換え・再起動・会話継続）

谺が会話の中で「自分に無い機能が必要だ」と判断したとき，主人の承認を得たうえで自分自身のソースコードを書き換え，再起動して会話を継続する能力を実装した（`brain/selfmod.ts`）．フローと安全設計は次のとおり．

1. **提案と承認**: システムプロンプトで「勝手に変更しない．何をどう変えるかを提案し，明示的な承認を得る」ことを義務づける．
2. **参照とステージ**: `self_list_source`/`self_read_source`で現在の実装を確認し，`self_stage_change`（old/new部分置換 または 全文）で変更をメモリ上にステージする．実ファイルにはまだ触れない．書き込み先は`packages/*/src`と`scripts/`配下に限定し，`.env`・`data/`・`node_modules`等は読み書きとも拒否する．
3. **隔離検証**: `self_validate_changes`が`data/selfmod/stage/`へソースツリーを複製し，ステージ変更を重ねて`tsc --noEmit`で型検査する（`@kodama/shared`は`paths`でステージ内へ張り替え，sharedの変更も正しく検査される）．実ツリーは無傷のまま，エラーは行番号つきで谺に返り，修正・再検証を繰り返せる．
4. **適用と再起動**: `self_restart`で予約し，**応答の読み上げ完了後**に適用する．適用は (a)再開マーカー（`selfmodResume`＝直前セッションID＋報告文）をDBへ永続化 →(b)元ファイルを`data/selfmod/backups/`へ退避し`pending.json`を記録 →(c)実ファイルへ書き込み →(d)`exit(87)`，の順で行う．マーカーを最初に書くため，どの時点で再起動が走っても会話は復元できる．
5. **監督と自動巻き戻し**: `npm run serve`は監督プロセス`scripts/serve-forever.mjs`経由となり，exit 87で即再起動する．起動直後のクラッシュ時に`pending.json`が残っていればバックアップから自動で巻き戻して再起動し，`rolledback.json`を残す．デスクトップ（`main.cjs`）もexit 87で再起動する．`npm run dev`は`tsx watch`のファイル変更検知が再起動を担う．
6. **会話継続**: 起動時に`orchestrator.handleSelfmodBoot()`が再開マーカーを検出すると，直前セッションの履歴（最大40件）を引き継ぎ，適用成功なら`self_restart`のmessage，巻き戻しなら失敗の旨を，履歴に記録したうえで音声でも報告する．主人から見ると「変えてきます」→（十数秒）→「追加しました．お試しください」と会話が途切れず続く．

パッケージ版（ソースツリー・`node_modules`が無い環境）では`selfModAvailable()`が偽となり，ツール群・プロンプト節とも自動で無効化される．機能全体は`SELF_MOD=0`でも殺せる．
