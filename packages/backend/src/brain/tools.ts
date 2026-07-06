import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import type { AssistantState, ServerEvent } from "@kodama/shared";
import type { Store } from "../memory/store.js";
import type { Lexicon } from "../tts/lexicon.js";
import { config } from "../config.js";
import { searchPapers, readPaper } from "./integrations/papers.js";
import { SelfMod, selfModAvailable } from "./selfmod.js";
import type { SpeakerIdentifier } from "../perception/speakerId.js";
import {
  notionSearch,
  notionGetPage,
  notionAppend,
  notionCreatePage,
} from "./integrations/notion.js";

/** アシスタントの名前・主人など, 任意設定できるアイデンティティ */
export interface IdentityPatch {
  name?: string;
  nameReading?: string;
  owner?: string;
  ownerReading?: string;
  ownerHonorific?: string;
}

/** 会話から変更できる谺の実行時設定 */
export interface SettingsView extends IdentityPatch {
  speechSpeed: number;
  voice: string;
  voiceTone: string;
  micSensitivity: number;
}

export interface SettingsController {
  view(): SettingsView;
  setSpeechSpeed(speed: number): void;
  setVoice(voice: string): void;
  setVoiceTone(instructions: string): void;
  setMicSensitivity(sensitivity: number): void;
  setIdentity(id: IdentityPatch): void;
}

export interface ToolContext {
  store: Store;
  getPresence: () => boolean;
  getState: () => AssistantState;
  lexicon?: Lexicon;
  settings?: SettingsController;
  /** Web UIへイベントを送る（生成UI描画・ブラウザ起動など, §15.4） */
  emit?: (ev: ServerEvent) => void;
  /** 自己改修（自分のソースの参照・変更ステージ・検証） */
  selfmod?: SelfMod;
  /** 話者識別（声の登録・一覧・削除） */
  speakers?: SpeakerIdentifier;
  /** 応答の読み上げ完了後に自己改修の適用＋再起動を予約する */
  requestRestart?: (note: string) => void;
}

/**
 * Claude tool use の道具立て.
 * 外部認証の要らないローカル完結のツールを実装し, 枠組みを通して動かす.
 * カレンダー/メール/Notion等の外部サービスは, この配列に同形で追加していく.
 */
const BASE_TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: "get_current_time",
    description: "現在の日時を取得する．予定や時間に関する質問に使う．",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_room_state",
    description: "研究室の在室状況と秘書の現在の対話状態を取得する．",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "remember",
    description:
      "ユーザに関する事実や指示を長期メモとしてローカルに保存する．後で recall で想起できる．",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "記憶する内容" },
        kind: { type: "string", description: "分類（任意）例: preference, fact, task" },
      },
      required: ["content"],
    },
  },
  {
    name: "recall",
    description: "過去に明示的に保存した長期メモ（remember した事実・指示）を検索して想起する．",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "検索語" },
      },
      required: ["query"],
    },
  },
  {
    name: "learn_behavior",
    description:
      "自分自身の振る舞いを制御する知識（行動指針）をDBに保存する．主人からの指示・訂正・好み（「これからは〜して」「〜はやめて」「私は〜が好き」）や, やり取りから学んだ教訓・注意点・手順を受け取ったら使う．保存した指針は毎回の応答時にプロンプトへ差し込まれ, 以後の振る舞いに反映される．時間が経つと状況が変わりうる知識は permanent=false（既定）とし, 半減期 half_life_days（既定30日）で鮮度が下がる．「常に敬語で話す」のような普遍的で変わらない原則だけ permanent=true にする．",
    input_schema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "指針の本文（1文で簡潔に．例: 論文要約は結論から3文以内で述べる）",
        },
        kind: {
          type: "string",
          description: "分類: preference（好み）/ rule（ルール）/ procedure（手順）/ context（状況知識）/ other",
        },
        permanent: {
          type: "boolean",
          description: "普遍的で陳腐化しない原則なら true（既定 false）",
        },
        half_life_days: {
          type: "number",
          description:
            "鮮度の半減期（日, 既定30）．すぐ変わりうる状況知識は短く（例: 7）, 長く保つ知識は長く（例: 180）",
        },
        weight: {
          type: "number",
          description: "重要度（既定1．重要なら2〜3）",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "list_behaviors",
    description:
      "蓄えた行動指針の一覧を鮮度（%）つきで確認する．「どんなルールを覚えてる？」への回答や, 指針の見直し・整理（update_behavior の id 特定）に使う．",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "update_behavior",
    description:
      "行動指針を更新する．指針がまだ有効だと確認できたら refresh=true で鮮度を今に戻す．廃止された指針は active=false にする（削除はせず記録として残る）．内容の修正・恒久化（permanent）・重要度変更もできる．id は list_behaviors やプロンプト内に示される先頭8文字でよい．",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "対象の id（先頭一致でよい）" },
        refresh: {
          type: "boolean",
          description: "有効性を再確認できたので鮮度を今にリセットする",
        },
        active: { type: "boolean", description: "false で廃止（無効化）" },
        content: { type: "string", description: "本文の修正（任意）" },
        permanent: { type: "boolean", description: "恒久フラグの変更（任意）" },
        weight: { type: "number", description: "重要度の変更（任意）" },
        half_life_days: { type: "number", description: "半減期の変更（任意）" },
      },
      required: ["id"],
    },
  },
  {
    name: "search_history",
    description:
      "ローカルDB内の全データ（過去の会話・トピック要約・長期メモ・語彙）を横断検索して想起する．「前に話した」「あの件」「以前◯◯と言っていた」など過去の文脈を参照する質問で使う．",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "検索語（人名・話題・キーワード）" },
        scope: {
          type: "array",
          description:
            "対象の絞り込み（省略時は全部）．message=会話, topic=話題要約, memory=長期メモ, term=語彙",
          items: {
            type: "string",
            enum: ["message", "topic", "memory", "term"],
          },
        },
      },
      required: ["query"],
    },
  },
  {
    name: "learn_term",
    description:
      "固有名詞・専門用語・プロジェクト名・人名を語彙として覚える．以後その語の音声認識精度が上がる．「◯◯という用語を覚えて」「△△は私の研究プロジェクト」のように教わったとき使う．読みが分かれば reading も渡すと読み上げにも反映される．",
    input_schema: {
      type: "object",
      properties: {
        surface: { type: "string", description: "表記（例: 谺システム）" },
        reading: {
          type: "string",
          description: "読み（ひらがな/カタカナ．分かれば）",
        },
        kind: {
          type: "string",
          description: "種別: person / project / jargon / place / other",
        },
        aliases: {
          type: "array",
          description: "誤認識されやすい異表記（任意）",
          items: { type: "string" },
        },
      },
      required: ["surface"],
    },
  },
  {
    name: "register_reading",
    description:
      "固有名詞などの読み方を発音辞書に登録する．以後その語は登録した読みで音声合成される．「『油谷』は『あぶらたに』と読んで」のような依頼で使う．",
    input_schema: {
      type: "object",
      properties: {
        surface: { type: "string", description: "表記（漢字など）例: 油谷" },
        reading: {
          type: "string",
          description: "読み（ひらがな/カタカナ）例: あぶらたに",
        },
      },
      required: ["surface", "reading"],
    },
  },
  {
    name: "get_settings",
    description:
      "谺の現在の設定（話す速度・声・声のトーン・マイク感度）を取得する．「もう少し速く」等の相対的な変更前に現在値を確認するのに使う．",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_speech_speed",
    description:
      "谺の話す速度を変更する．1.0が標準, 大きいほど速い（目安: 1.0≈300字/分）．「もう少し速く/ゆっくり」と言われたら現在値から0.1〜0.2ずつ調整する．",
    input_schema: {
      type: "object",
      properties: {
        speed: {
          type: "number",
          description: "再生速度倍率（0.5〜2.0）",
        },
      },
      required: ["speed"],
    },
  },
  {
    name: "set_voice",
    description:
      "谺の声（話者）を変更する．男性的: onyx, ash, echo, verse／女性的: alloy, coral, sage, shimmer, nova/中性: ballad, fable．",
    input_schema: {
      type: "object",
      properties: {
        voice: {
          type: "string",
          description:
            "声の名前（onyx/ash/echo/verse/alloy/coral/sage/shimmer/nova/ballad/fable のいずれか）",
        },
      },
      required: ["voice"],
    },
  },
  {
    name: "set_voice_tone",
    description:
      "谺の声のトーン・口調の指示を変更する（音声合成へ渡す自然文）．例:「明るく親しみやすく」「落ち着いて低めに」．",
    input_schema: {
      type: "object",
      properties: {
        instructions: {
          type: "string",
          description: "トーンの指示（日本語の自然文）",
        },
      },
      required: ["instructions"],
    },
  },
  {
    name: "set_identity",
    description:
      "アシスタント自身の名前・読み・主人（オーナー）の名前/読み/呼び方を変更する．「君の名前を〇〇にして」「これからは△△さんのアシスタントね」「僕のことは□□と呼んで」のような依頼で使う．変更したい項目だけ指定すればよい．",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "アシスタントの新しい名前（例: ミミ）" },
        name_reading: { type: "string", description: "名前の読み（ひらがな/カタカナ）" },
        owner: { type: "string", description: "主人の名前" },
        owner_reading: { type: "string", description: "主人の名前の読み" },
        owner_honorific: { type: "string", description: "主人の呼び方（例: 田中さん）" },
      },
    },
  },
  {
    name: "set_mic_sensitivity",
    description:
      "マイク感度を変更する．1（鈍感・雑音に強い）〜10（敏感・小さな声も拾う）．「感度を上げて/下げて」と言われたら現在値から1〜2ずつ調整する．",
    input_schema: {
      type: "object",
      properties: {
        sensitivity: {
          type: "number",
          description: "マイク感度（1〜10の整数）",
        },
      },
      required: ["sensitivity"],
    },
  },
];

/**
 * 話者識別ツール（声による個人識別）.
 * 発話には自動で（話者: 名前）タグが付く. 未登録の声は「ゲストA」等の仮ラベルになるため,
 * 名前を教わったら enroll_speaker で声ごと正式登録する（＝声を覚える）.
 */
const SPEAKER_TOOLS: Anthropic.Tool[] = [
  {
    name: "enroll_speaker",
    description:
      "いま話している（直近に発話した）人の声を, 名前つきで話者として登録する．発話タグが「ゲスト◯」の未登録話者から名前を教わったとき（「私は田中です」等）に使う．登録すると以後の発話は自動でその名前で識別される．同名の既存話者に使うと声サンプルが追加され識別精度が上がる．guest でどのゲストかを明示できる（省略時は直近に発話したゲスト）．",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "話者の名前（例: 田中太郎）" },
        reading: {
          type: "string",
          description: "名前の読み（ひらがな/カタカナ．分かれば）",
        },
        guest: {
          type: "string",
          description: "登録対象のゲストラベル（例: ゲストA．省略時は直近の発話者）",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "list_speakers",
    description:
      "声を登録済みの話者の一覧（名前・声サンプル数・登録日）を確認する．「誰の声を覚えてる？」への回答や, rename_speaker / forget_speaker の対象確認に使う．",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "rename_speaker",
    description:
      "登録済み話者の名前を変更する．「◯◯じゃなくて△△だよ」のような訂正で使う．",
    input_schema: {
      type: "object",
      properties: {
        old_name: { type: "string", description: "現在の登録名" },
        new_name: { type: "string", description: "新しい名前" },
        reading: { type: "string", description: "新しい読み（任意）" },
      },
      required: ["old_name", "new_name"],
    },
  },
  {
    name: "forget_speaker",
    description:
      "登録済み話者の声を忘れる（登録を削除する）．本人や主人から明確に頼まれたときだけ使う．",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "削除する話者の登録名" },
      },
      required: ["name"],
    },
  },
];

/** 研究文献（ローカル）参照ツール */
const PAPER_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_papers",
    description:
      "油谷の研究文献（ローカル保管の論文・発表PDF）をファイル名・分野で検索する．研究内容・先行研究・自身の発表・専門用語に関する質問では, まずこれで関連文献を探す．",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "検索語（日本語可．スペース区切りで複数語）" },
      },
      required: ["query"],
    },
  },
  {
    name: "read_paper",
    description:
      "search_papers で見つけた文献の本文を読み取る（PDFはテキスト抽出）．引用や具体的内容に触れる前に本文を確認するのに使う．",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "search_papers が返した相対パス" },
      },
      required: ["path"],
    },
  },
];

/** Notion 参照ツール（NOTION_TOKEN 設定時のみ有効） */
const NOTION_TOOLS: Anthropic.Tool[] = [
  {
    name: "notion_search",
    description:
      "Notion 内のページ・データベースを検索する．メモ・議事録・タスク・企画など, 油谷がNotionに記録した内容を参照するのに使う．",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "検索語" },
      },
      required: ["query"],
    },
  },
  {
    name: "notion_get_page",
    description:
      "notion_search で見つけたページの本文を取得する．",
    input_schema: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "notion_search が返した id" },
      },
      required: ["page_id"],
    },
  },
  {
    name: "notion_append",
    description:
      "既存のNotionページの末尾にテキストを追記する．「これをNotionの〇〇に書いておいて／追記して」のような依頼で使う．対象ページが曖昧なら notion_search で id を特定してから追記する．",
    input_schema: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "追記先ページの id（notion_search の結果）" },
        text: { type: "string", description: "追記する本文（改行で複数段落になる）" },
      },
      required: ["page_id", "text"],
    },
  },
  {
    name: "notion_create_page",
    description:
      "親ページの下に新しいNotionサブページを作成する．「Notionに〇〇というメモ／議事録を作って」のような依頼で使う．親ページが不明なら notion_search で候補を探して親の id を決める．",
    input_schema: {
      type: "object",
      properties: {
        parent_id: { type: "string", description: "親ページの id" },
        title: { type: "string", description: "新規ページのタイトル" },
        content: { type: "string", description: "本文（任意．改行で複数段落）" },
      },
      required: ["parent_id", "title"],
    },
  },
];

/**
 * 画面（生成UI）・ブラウザ連携ツール（§15.4）.
 * 音声だけでは伝えにくい構造的な情報を, ブラウザ上に表・カード・フォーム等で示す.
 */
const UI_TOOLS: Anthropic.Tool[] = [
  {
    name: "open_url",
    description:
      "実ブラウザ（既定ブラウザ／新規タブ）でURLを開く．Web検索結果や参照ページ, ダッシュボード等を実際に開いて見せ, ユーザがその場で操作できるようにする．口頭の補足として開く．",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "開くURL（http/https）" },
        title: { type: "string", description: "用途の短い説明（任意）" },
      },
      required: ["url"],
    },
  },
  {
    name: "save_file",
    description:
      "テキストの成果物（メモ・原稿・表・コード・データ等）をファイルとしてローカルDBへ保存し, 画面にダウンロードカードを表示してユーザが受け取れるようにする．「ファイルにして」「まとめてダウンロードできるように」等, 作った内容を渡す場面で使う．内容はファイル名の拡張子に応じた形式（.md/.txt/.csv/.json/.html等）で書く．",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "ファイル名（拡張子つき．例: 会議メモ.md, データ.csv）",
        },
        content: { type: "string", description: "ファイルの中身（テキスト）" },
        title: {
          type: "string",
          description: "ダウンロードカードの見出し（任意．例: 会議メモをまとめました）",
        },
      },
      required: ["name", "content"],
    },
  },
  {
    name: "list_files",
    description:
      "DBに保存されているファイル（ユーザから受領したもの・save_fileで作ったもの）の一覧をメタデータ（id・名前・種類・サイズ・日時）で確認する．「あのファイル」「前にもらった資料」等を特定するのに使う．",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "offer_file_download",
    description:
      "DBに保存済みのファイルを, 画面のダウンロードカードとしてユーザに提示する．「あのファイルをちょうだい」「さっきの資料をダウンロードしたい」等の依頼で使う．id が不明なら先に list_files で確認する．",
    input_schema: {
      type: "object",
      properties: {
        file_ids: {
          type: "array",
          description: "提示するファイルの id（list_files や保存時の結果から）",
          items: { type: "string" },
        },
        title: {
          type: "string",
          description: "カードの見出し（任意）",
        },
      },
      required: ["file_ids"],
    },
  },
  {
    name: "request_file_upload",
    description:
      "ユーザの手元のファイルを受け取るためのアップロードエリア（ドラッグ&ドロップ）を画面に一時表示する．「このPDFを見て」「ファイルを渡したい」「資料を読んで」など, ユーザのファイルが必要な場面で使う．ユーザがファイルを置くとローカルDBへ保存され, 結果（ファイル名とid）が（ファイル受領）として次の入力で届く．表示した後は, ファイルを置くよう口頭で促して操作を待つこと．",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "エリアに表示する依頼文（例: 査読対象のPDFをここにドロップしてください）",
        },
        accept: {
          type: "string",
          description:
            "受け付けるファイル種別（input の accept 形式．例: .pdf や image/*．省略で全て）",
        },
        multiple: {
          type: "boolean",
          description: "複数ファイルを受け付けるか（既定true）",
        },
      },
    },
  },
  {
    name: "render_ui",
    description:
      "その場でHTML/CSSの画面を生成し, ブラウザ上のパネルに描画してユーザに見せる．一覧・表・比較・カード・選択肢など, 音声だけでは伝わりにくい構造的な情報の提示に使う．interactive=true にするとボタン/フォーム等で操作でき, 操作内容は谺への入力として返ってくる（その際は window.parent.postMessage({kodama:true, name, value}, '*') で値を返すJSを含める）．",
    input_schema: {
      type: "object",
      properties: {
        html: { type: "string", description: "パネルに表示するHTML本文（bodyの中身）" },
        css: { type: "string", description: "適用するCSS（任意）" },
        title: { type: "string", description: "パネルの見出し（任意）" },
        interactive: {
          type: "boolean",
          description: "ボタン/フォーム等のスクリプトを有効化するか（既定false=静的表示）",
        },
      },
      required: ["html"],
    },
  },
];

/**
 * 自己改修ツール（谺が自分のソースコードを承認制で書き換える）.
 * フロー: 主人へ提案・承認 → 参照 → ステージ → 検証（隔離コピーで型検査）→ 適用・再起動.
 * 再起動後も会話は継続される（orchestrator が履歴を引き継ぎ, 結果を口頭報告する）.
 */
const SELF_TOOLS: Anthropic.Tool[] = [
  {
    name: "self_list_source",
    description:
      "谺自身のソースコード（このシステムの実装）のファイル一覧を確認する．自己改修の最初の一歩として, どこに何があるかを把握するのに使う．",
    input_schema: {
      type: "object",
      properties: {
        dir: {
          type: "string",
          description:
            "絞り込むディレクトリ（リポジトリ相対．例: packages/backend/src/core．省略で全体）",
        },
      },
    },
  },
  {
    name: "self_read_source",
    description:
      "谺自身のソースファイルの内容を読む．変更前に必ず該当箇所の現在の実装を確認する．",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "リポジトリ相対パス（例: packages/backend/src/core/orchestrator.ts）",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "self_stage_change",
    description:
      "谺自身のソースコードへの変更をステージする（この時点では実ファイルに触れない）．既存ファイルの部分修正は old_string（一意に一致する現在のコード）と new_string を渡す．新規ファイル作成や全文置換は content を渡す．複数ファイルの変更は本ツールを繰り返し呼ぶ．主人の承認を得てから使うこと．",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "対象のリポジトリ相対パス（packages/*/src または scripts/ 配下）",
        },
        old_string: {
          type: "string",
          description: "置換元のコード（ファイル内で一意に一致すること．content 指定時は不要）",
        },
        new_string: {
          type: "string",
          description: "置換後のコード（old_string とセットで使う）",
        },
        content: {
          type: "string",
          description: "ファイル全文（新規作成・全文置換のとき）",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "self_validate_changes",
    description:
      "ステージ中の変更一式を, 実ファイルに触れない隔離コピー上で型検査（tsc）する．失敗したらエラーを読んで修正・再ステージする．適用（self_restart）前に必ず通すこと．",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "self_discard_changes",
    description: "ステージ中の自己改修の変更をすべて破棄する（実ファイルは元々無傷）．",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "self_restart",
    description:
      "検証済みのステージ変更を実ファイルへ適用し, 谺自身を再起動する．この返答の読み上げが終わってから自動で実行され, 再起動後は会話が引き継がれて message の内容を口頭報告する．ステージが空の場合は単純な再起動になる．必ず主人の承認を得てから使うこと．",
    input_schema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description:
            "再起動直後に主人へ報告する一言（例: 新しい機能『◯◯』を追加しました．お試しください）",
        },
      },
    },
  },
];

/**
 * Web検索（Anthropic公式のサーバサイドツール）.
 * Claudeがサーバ側で検索・本文取得・引用までを行うため, クライアント側の実装（runTool）は不要.
 * 最新情報・時事・ローカル資料に無い一般知識の質問に使う.
 */
const WEB_SEARCH_TOOL: Anthropic.WebSearchTool20250305 = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: config.webSearchMaxUses,
  user_location: { type: "approximate", country: "JP", timezone: "Asia/Tokyo" },
};

export const TOOL_DEFS: Anthropic.ToolUnion[] = [
  ...BASE_TOOL_DEFS,
  ...(config.speakerId ? SPEAKER_TOOLS : []),
  ...PAPER_TOOLS,
  ...UI_TOOLS,
  ...(config.selfMod && selfModAvailable() ? SELF_TOOLS : []),
  ...(config.notionToken ? NOTION_TOOLS : []),
  ...(config.webSearch ? [WEB_SEARCH_TOOL] : []),
];

/** ファイル名の拡張子からMIMEタイプを推定する（save_file 用）. */
function mimeFromName(name: string): string {
  const ext = name.toLowerCase().replace(/^.*\./, "");
  const map: Record<string, string> = {
    md: "text/markdown",
    txt: "text/plain",
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    json: "application/json",
    html: "text/html",
    xml: "application/xml",
    tex: "application/x-tex",
    bib: "text/plain",
    py: "text/x-python",
    js: "text/javascript",
    ts: "text/plain",
  };
  return map[ext] ?? "text/plain";
}

export async function runTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<string> {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "get_current_time":
      return new Date().toLocaleString("ja-JP", {
        dateStyle: "full",
        timeStyle: "short",
      });

    case "get_room_state":
      return JSON.stringify({
        present: ctx.getPresence(),
        state: ctx.getState(),
      });

    case "remember": {
      const content = String(args.content ?? "").trim();
      if (!content) return "保存する内容が空でした．";
      const kind = String(args.kind ?? "fact");
      ctx.store.addMemory(kind, content);
      return "記憶しました．";
    }

    case "recall": {
      const query = String(args.query ?? "").trim();
      const hits = ctx.store.searchMemories(query, 10);
      if (hits.length === 0) return "該当する記憶はありません．";
      return hits.map((m) => `- (${m.kind}) ${m.content}`).join("\n");
    }

    case "learn_behavior": {
      const content = String(args.content ?? "").trim();
      if (!content) return "指針の内容が空でした．";
      const rec = ctx.store.addBehavior({
        content,
        kind: args.kind ? String(args.kind) : undefined,
        permanent: args.permanent === undefined ? undefined : !!args.permanent,
        weight: Number.isFinite(Number(args.weight))
          ? Number(args.weight)
          : undefined,
        halfLifeDays: Number.isFinite(Number(args.half_life_days))
          ? Number(args.half_life_days)
          : undefined,
      });
      if (!rec) return "指針を保存できませんでした．";
      return `行動指針として保存しました（id: ${rec.id.slice(0, 8)}, ${
        rec.permanent ? "恒久" : `半減期${rec.halfLifeDays}日`
      }）．以後の応答に反映されます．`;
    }

    case "list_behaviors": {
      const notes = ctx.store.listBehaviors(true);
      if (!notes.length) return "行動指針はまだありません．";
      return notes
        .map((n) => {
          const state = !n.active
            ? "廃止"
            : n.permanent
              ? "恒久"
              : `鮮度${Math.round(n.freshness * 100)}%・半減期${n.halfLifeDays}日`;
          return `- [${n.id.slice(0, 8)}] (${n.kind}/${state}/重要度${n.weight}) ${n.content}（登録: ${n.createdAt.slice(0, 10)}, 最終確認: ${n.updatedAt.slice(0, 10)}）`;
        })
        .join("\n");
    }

    case "update_behavior": {
      const id = String(args.id ?? "").trim();
      if (!id) return "id が必要です．";
      const rec = ctx.store.updateBehavior(id, {
        content: args.content ? String(args.content) : undefined,
        permanent: args.permanent === undefined ? undefined : !!args.permanent,
        active: args.active === undefined ? undefined : !!args.active,
        refresh: !!args.refresh,
        weight: Number.isFinite(Number(args.weight))
          ? Number(args.weight)
          : undefined,
        halfLifeDays: Number.isFinite(Number(args.half_life_days))
          ? Number(args.half_life_days)
          : undefined,
      });
      if (!rec)
        return "該当する指針が見つからないか, idが複数に一致しました．list_behaviors で確認してください．";
      return `更新しました: [${rec.id.slice(0, 8)}] ${rec.content}（${
        !rec.active ? "廃止" : rec.permanent ? "恒久" : "有効"
      }）`;
    }

    case "search_history": {
      const query = String(args.query ?? "").trim();
      if (!query) return "検索語が必要です．";
      const scope = Array.isArray(args.scope)
        ? (args.scope as string[]).filter((s) =>
            ["message", "topic", "memory", "term"].includes(s),
          )
        : undefined;
      const hits = ctx.store.searchAll(query, {
        scope: scope as ("message" | "topic" | "memory" | "term")[] | undefined,
        limit: 20,
      });
      if (hits.length === 0) return "DB内に該当する記録はありません．";
      return hits
        .map((h) => `- [${h.source}] ${h.title}（${h.at.slice(0, 10)}）: ${h.snippet}`)
        .join("\n");
    }

    case "register_reading": {
      const surface = String(args.surface ?? "").trim();
      const reading = String(args.reading ?? "").trim();
      if (!surface || !reading) return "表記と読みの両方が必要です．";
      if (!ctx.lexicon) return "発音辞書が利用できません．";
      ctx.lexicon.add(surface, reading);
      // 読みの登録は語彙登録も兼ねる（認識ヒントにも載せる, §15.1）.
      ctx.store.upsertTerm({ surface, reading, source: "user", weight: 1 });
      return `「${surface}」を「${reading}」と読むよう発音辞書に登録しました．`;
    }

    case "learn_term": {
      const surface = String(args.surface ?? "").trim();
      if (!surface) return "覚える語（表記）が必要です．";
      const reading = args.reading ? String(args.reading).trim() : null;
      const kind = args.kind ? String(args.kind).trim() : "other";
      const aliases = Array.isArray(args.aliases)
        ? (args.aliases as unknown[]).map((a) => String(a).trim()).filter(Boolean)
        : [];
      ctx.store.upsertTerm({
        surface,
        reading,
        kind,
        aliases,
        source: "user",
        weight: 1,
      });
      // 読みが分かれば発音辞書にも反映する.
      if (reading && ctx.lexicon) ctx.lexicon.add(surface, reading);
      return `「${surface}」を語彙として覚えました．以後の聞き取り精度が上がります．`;
    }

    case "get_settings": {
      if (!ctx.settings) return "設定機能が利用できません．";
      const v = ctx.settings.view();
      return JSON.stringify({
        名前: v.name,
        名前の読み: v.nameReading,
        主人: v.owner,
        主人の読み: v.ownerReading,
        主人の呼び方: v.ownerHonorific,
        話速: v.speechSpeed,
        声: v.voice,
        声のトーン: v.voiceTone,
        マイク感度: v.micSensitivity,
      });
    }

    case "set_speech_speed": {
      if (!ctx.settings) return "設定機能が利用できません．";
      const speed = Number(args.speed);
      if (!Number.isFinite(speed)) return "速度の指定が不正です．";
      ctx.settings.setSpeechSpeed(speed);
      return `話す速度を ${ctx.settings.view().speechSpeed} に変更しました．`;
    }

    case "set_voice": {
      if (!ctx.settings) return "設定機能が利用できません．";
      const voice = String(args.voice ?? "").trim();
      if (!voice) return "声の名前が必要です．";
      ctx.settings.setVoice(voice);
      return `声を「${voice}」に変更しました．次の発話から反映されます．`;
    }

    case "set_voice_tone": {
      if (!ctx.settings) return "設定機能が利用できません．";
      const instructions = String(args.instructions ?? "").trim();
      if (!instructions) return "トーンの指示が必要です．";
      ctx.settings.setVoiceTone(instructions);
      return "声のトーンを更新しました．次の発話から反映されます．";
    }

    case "set_identity": {
      if (!ctx.settings) return "設定機能が利用できません．";
      const patch: Record<string, string> = {};
      if (args.name != null) patch.name = String(args.name).trim();
      if (args.name_reading != null) patch.nameReading = String(args.name_reading).trim();
      if (args.owner != null) patch.owner = String(args.owner).trim();
      if (args.owner_reading != null) patch.ownerReading = String(args.owner_reading).trim();
      if (args.owner_honorific != null)
        patch.ownerHonorific = String(args.owner_honorific).trim();
      if (Object.keys(patch).length === 0) return "変更する項目がありません．";
      ctx.settings.setIdentity(patch);
      const v = ctx.settings.view();
      return `更新しました．現在: 名前「${v.name}」/ 主人「${v.owner}」/ 呼び方「${v.ownerHonorific ?? ""}」`;
    }

    case "set_mic_sensitivity": {
      if (!ctx.settings) return "設定機能が利用できません．";
      const sensitivity = Number(args.sensitivity);
      if (!Number.isFinite(sensitivity)) return "感度の指定が不正です．";
      ctx.settings.setMicSensitivity(sensitivity);
      return `マイク感度を ${ctx.settings.view().micSensitivity} に変更しました．`;
    }

    case "enroll_speaker": {
      if (!ctx.speakers) return "話者識別機能が利用できません．";
      const name = String(args.name ?? "").trim();
      if (!name) return "登録する名前が必要です．";
      const reading = args.reading ? String(args.reading).trim() : null;
      const guest = args.guest ? String(args.guest).trim() : undefined;
      const r = ctx.speakers.enroll(name, reading, guest);
      if (r.ok) {
        // 名前は語彙・発音辞書にも反映し, 以後の聞き取り・読み上げ精度を上げる.
        ctx.store.upsertTerm({
          surface: name,
          reading,
          kind: "person",
          source: "user",
          weight: 1,
        });
        if (reading && ctx.lexicon) ctx.lexicon.add(name, reading);
      }
      return r.message;
    }

    case "list_speakers": {
      if (!ctx.speakers) return "話者識別機能が利用できません．";
      const list = ctx.speakers.list();
      if (!list.length) return "声を登録済みの話者はまだいません．";
      return list
        .map(
          (s) =>
            `- ${s.name}${s.reading ? `（${s.reading}）` : ""}: 声サンプル${s.sampleCount}件, 登録 ${s.createdAt.slice(0, 10)}`,
        )
        .join("\n");
    }

    case "rename_speaker": {
      if (!ctx.speakers) return "話者識別機能が利用できません．";
      const oldName = String(args.old_name ?? "").trim();
      const newName = String(args.new_name ?? "").trim();
      if (!oldName || !newName) return "old_name と new_name が必要です．";
      const ok = ctx.speakers.rename(
        oldName,
        newName,
        args.reading ? String(args.reading).trim() : null,
      );
      return ok
        ? `話者「${oldName}」を「${newName}」に変更しました．`
        : `「${oldName}」という登録話者は見つかりませんでした．list_speakers で確認してください．`;
    }

    case "forget_speaker": {
      if (!ctx.speakers) return "話者識別機能が利用できません．";
      const name = String(args.name ?? "").trim();
      if (!name) return "削除する話者名が必要です．";
      const ok = ctx.speakers.forget(name);
      return ok
        ? `話者「${name}」の声の登録を削除しました．`
        : `「${name}」という登録話者は見つかりませんでした．`;
    }

    case "search_papers": {
      const query = String(args.query ?? "").trim();
      if (!query) return "検索語が必要です．";
      const hits = searchPapers(query);
      if (!hits.length) return "該当する文献は見つかりませんでした．";
      return hits.map((p) => `- ${p}`).join("\n");
    }

    case "read_paper": {
      const path = String(args.path ?? "").trim();
      if (!path) return "パスが必要です．";
      try {
        return await readPaper(path);
      } catch (e) {
        return `文献の読み取りに失敗しました: ${(e as Error).message}`;
      }
    }

    case "self_list_source": {
      if (!ctx.selfmod) return "自己改修機能は利用できません．";
      try {
        return ctx.selfmod.listSource(args.dir ? String(args.dir) : undefined);
      } catch (e) {
        return `一覧の取得に失敗しました: ${(e as Error).message}`;
      }
    }

    case "self_read_source": {
      if (!ctx.selfmod) return "自己改修機能は利用できません．";
      const path = String(args.path ?? "").trim();
      if (!path) return "path が必要です．";
      try {
        return ctx.selfmod.readSource(path);
      } catch (e) {
        return `読み取りに失敗しました: ${(e as Error).message}`;
      }
    }

    case "self_stage_change": {
      if (!ctx.selfmod) return "自己改修機能は利用できません．";
      const path = String(args.path ?? "").trim();
      if (!path) return "path が必要です．";
      try {
        if (args.content !== undefined) {
          return ctx.selfmod.stageWrite(path, String(args.content));
        }
        const oldStr = String(args.old_string ?? "");
        const newStr = String(args.new_string ?? "");
        if (!oldStr) return "content か old_string/new_string のどちらかが必要です．";
        return ctx.selfmod.stageEdit(path, oldStr, newStr);
      } catch (e) {
        return `ステージに失敗しました: ${(e as Error).message}`;
      }
    }

    case "self_validate_changes": {
      if (!ctx.selfmod) return "自己改修機能は利用できません．";
      try {
        return await ctx.selfmod.validate();
      } catch (e) {
        return `検証に失敗しました: ${(e as Error).message}`;
      }
    }

    case "self_discard_changes": {
      if (!ctx.selfmod) return "自己改修機能は利用できません．";
      return ctx.selfmod.discard();
    }

    case "self_restart": {
      if (!ctx.selfmod || !ctx.requestRestart) return "自己改修機能は利用できません．";
      if (ctx.selfmod.hasStaged() && !ctx.selfmod.isValidated()) {
        return "未検証の変更がステージされています．先に self_validate_changes で型検査を通してください．";
      }
      ctx.requestRestart(String(args.message ?? "").trim());
      return (
        "承知しました．この返答の読み上げが完了し次第, 変更を適用して再起動します．" +
        "再起動後は会話が引き継がれます．短い締めの一言で応答を終えてください．"
      );
    }

    case "notion_search": {
      if (!config.notionToken) return "Notion連携が未設定です（NOTION_TOKEN）．";
      const query = String(args.query ?? "").trim();
      if (!query) return "検索語が必要です．";
      try {
        return await notionSearch(query);
      } catch (e) {
        return `Notion検索に失敗しました: ${(e as Error).message}`;
      }
    }

    case "notion_get_page": {
      if (!config.notionToken) return "Notion連携が未設定です（NOTION_TOKEN）．";
      const pageId = String(args.page_id ?? "").trim();
      if (!pageId) return "page_id が必要です．";
      try {
        return await notionGetPage(pageId);
      } catch (e) {
        return `Notionページ取得に失敗しました: ${(e as Error).message}`;
      }
    }

    case "notion_append": {
      if (!config.notionToken) return "Notion連携が未設定です（NOTION_TOKEN）．";
      const pageId = String(args.page_id ?? "").trim();
      const text = String(args.text ?? "").trim();
      if (!pageId || !text) return "page_id と text が必要です．";
      try {
        return await notionAppend(pageId, text);
      } catch (e) {
        return `Notion追記に失敗しました: ${(e as Error).message}`;
      }
    }

    case "notion_create_page": {
      if (!config.notionToken) return "Notion連携が未設定です（NOTION_TOKEN）．";
      const parentId = String(args.parent_id ?? "").trim();
      const title = String(args.title ?? "").trim();
      const content = String(args.content ?? "");
      if (!parentId || !title) return "parent_id と title が必要です．";
      try {
        return await notionCreatePage(parentId, title, content);
      } catch (e) {
        return `Notionページ作成に失敗しました: ${(e as Error).message}`;
      }
    }

    case "open_url": {
      const url = String(args.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) return "http/httpsのURLが必要です．";
      if (!ctx.emit) return "画面表示が利用できません．";
      ctx.emit({ type: "ui_open_url", url, title: String(args.title ?? "") || undefined });
      return `ブラウザで開きました: ${url}`;
    }

    case "save_file": {
      const fileName = String(args.name ?? "").trim();
      const content = String(args.content ?? "");
      if (!fileName || !content) return "name と content が必要です．";
      const rec = ctx.store.saveFile({
        name: fileName,
        mimeType: mimeFromName(fileName),
        data: Buffer.from(content, "utf8"),
      });
      ctx.emit?.({
        type: "ui_download",
        id: randomUUID(),
        title: args.title ? String(args.title) : undefined,
        files: [rec],
      });
      return `「${rec.name}」を保存し, ダウンロードカードを表示しました（id: ${rec.id}, ${rec.size}バイト）．`;
    }

    case "list_files": {
      const files = ctx.store.listFiles(50);
      if (!files.length) return "保存されているファイルはありません．";
      return files
        .map(
          (f) =>
            `- ${f.name}（${f.mimeType}, ${f.size}バイト, ${f.createdAt.slice(0, 10)}, id: ${f.id}）`,
        )
        .join("\n");
    }

    case "offer_file_download": {
      if (!ctx.emit) return "画面表示が利用できません．";
      const ids = Array.isArray(args.file_ids)
        ? (args.file_ids as unknown[]).map((v) => String(v).trim()).filter(Boolean)
        : [];
      if (!ids.length) return "file_ids が必要です．";
      const found = ids
        .map((id) => ctx.store.getFileMeta(id))
        .filter((f): f is NonNullable<typeof f> => f != null);
      if (!found.length)
        return "指定されたidのファイルは見つかりませんでした．list_files で確認してください．";
      ctx.emit({
        type: "ui_download",
        id: randomUUID(),
        title: args.title ? String(args.title) : undefined,
        files: found,
      });
      const missing = ids.length - found.length;
      return (
        `ダウンロードカードを表示しました: ${found.map((f) => f.name).join(", ")}` +
        (missing > 0 ? `（${missing}件は見つかりませんでした）` : "")
      );
    }

    case "request_file_upload": {
      if (!ctx.emit) return "画面表示が利用できません．";
      ctx.emit({
        type: "ui_upload",
        id: randomUUID(),
        title: args.title ? String(args.title) : undefined,
        accept: args.accept ? String(args.accept) : undefined,
        multiple: args.multiple === undefined ? true : !!args.multiple,
      });
      return "アップロードエリアを表示しました．ユーザがファイルを置くと（ファイル受領）として届くので, ファイルを置くよう促して待ってください．";
    }

    case "render_ui": {
      const html = String(args.html ?? "").trim();
      if (!html) return "表示するHTMLが必要です．";
      if (!ctx.emit) return "画面表示が利用できません．";
      ctx.emit({
        type: "ui_render",
        id: randomUUID(),
        html,
        css: args.css ? String(args.css) : undefined,
        title: args.title ? String(args.title) : undefined,
        interactive: !!args.interactive,
      });
      return "画面に表示しました．";
    }

    default:
      return `未知のツール: ${name}`;
  }
}
