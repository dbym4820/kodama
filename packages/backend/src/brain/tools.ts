import type Anthropic from "@anthropic-ai/sdk";
import type { AssistantState } from "@kodama/shared";
import type { Store } from "../memory/store.js";
import type { Lexicon } from "../tts/lexicon.js";
import { config } from "../config.js";
import { searchPapers, readPaper } from "./integrations/papers.js";
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
    description: "過去に保存した長期メモを検索して想起する．",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "検索語" },
      },
      required: ["query"],
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
  ...PAPER_TOOLS,
  ...(config.notionToken ? NOTION_TOOLS : []),
  ...(config.webSearch ? [WEB_SEARCH_TOOL] : []),
];

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

    case "register_reading": {
      const surface = String(args.surface ?? "").trim();
      const reading = String(args.reading ?? "").trim();
      if (!surface || !reading) return "表記と読みの両方が必要です．";
      if (!ctx.lexicon) return "発音辞書が利用できません．";
      ctx.lexicon.add(surface, reading);
      return `「${surface}」を「${reading}」と読むよう発音辞書に登録しました．`;
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

    default:
      return `未知のツール: ${name}`;
  }
}
