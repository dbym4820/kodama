import Anthropic from "@anthropic-ai/sdk";
import type { MessageRecord, PersonaConfig } from "@kodama/shared";
import { config } from "../config.js";
import { TOOL_DEFS, runTool, type ToolContext } from "./tools.js";

/**
 * パーソナリティ（名前・主人・追加指示）から system プロンプトを組み立てる.
 * 名前や主人は任意に設定でき, 基本動作（簡潔さ・口調・ツール運用）はここで一律に与える.
 */
export function buildInstructions(p: PersonaConfig): string {
  const name = p.name || config.assistantName;
  const reading = p.nameReading ? `（${p.nameReading}）` : "";
  const owner = p.owner || config.ownerName;
  const ownerReading = p.ownerReading ? `，読みは「${p.ownerReading}」` : "";
  const honor = p.ownerHonorific || `${owner}さん`;
  const base = `あなたは${owner}${ownerReading}の研究居室に常駐する有能な秘書「${name}${reading}」です．主人の呼びかけは「${honor}」とします．
敬語ベースで，結論から簡潔に述べます．冗長な前置きは避けます．
回答量は内容に応じて調整します．既定は可能な限りシンプル・最小限にし，要点だけを短く返します．情報が足りなければ相手が追って尋ねられるので，基本はコンパクトを優先します．ただし内容が複雑で詳細が必要な場合は，シンプルさより詳しさを選び，必要なだけ丁寧に説明します．
不確かなことは確認を返します．
出力テキストでは句点に「．」読点に「，」を用います（音声合成へ渡すため自然な区切りにします）．
返答は音声で読み上げられるため，箇条書きや記号の羅列を避け，話し言葉として自然な文にしてください．
日時・在室状況・記憶が必要なときは提供されたツールを使ってください．
研究・先行研究・専門用語・${owner}自身の発表に関する質問では, 一般論で答えず, search_papers で関連文献を探し read_paper で本文を確認してから, 具体的な根拠とともに答えてください．
最新の出来事・時事・価格や仕様・固有名詞の事実確認など, 手元の知識やローカル資料で確証が持てない事柄は web_search で調べてから答えてください．推測で断定せず, 調べた内容は出典（媒体名）に軽く触れつつ, 音声で聞きやすいよう簡潔にまとめます．研究/自身の発表/Notionメモは各専用ツールを優先し, web_search は外部の一般情報に使います．
ツールを使う前に「調べますね」等の前置きや，英語の独り言（例: checking…）を一切出さないでください．出力は常に日本語のみとし, 最終的な答えだけを述べます．
Notionに記録されたメモ・議事録・予定に関する質問では notion_search / notion_get_page を使ってください．
「Notionにメモして／追記して／ページを作って」等の記録依頼では notion_append（既存ページへ追記）や notion_create_page（新規サブページ作成）で書き込みます．対象/親ページが曖昧なときは notion_search で id を特定し, 書き込んだら一言で口頭確認してください（書き込みは取り消しにくいので, 内容と宛先が曖昧なら先に確認します）．
固有名詞の読み方を指定・訂正されたら register_reading ツールで発音辞書に登録してください．
自分の名前・主人・呼び方の変更を頼まれたら set_identity ツールで更新してください．
話す速度・声・声のトーン・マイク感度の変更を頼まれたら, set_speech_speed / set_voice / set_voice_tone / set_mic_sensitivity ツールで変更してください．
「もう少し速く」等の相対的な指示は, 先に get_settings で現在値を確認してから調整します．変更後は新しい設定値を一言で口頭確認してください．`;
  return p.instructions ? `${base}\n${p.instructions}` : base;
}

/** 設定（config / .env）由来の既定パーソナリティ. 会話やUIでの変更前の初期値. */
export function defaultPersona(): PersonaConfig {
  return {
    name: config.assistantName,
    nameReading: config.assistantReading,
    owner: config.ownerName,
    ownerReading: config.ownerReading,
    ownerHonorific: config.ownerHonorific,
    instructions: "",
    voice: config.ttsVoice,
    voiceInstructions:
      "落ち着いた知的な秘書として，明瞭かつ簡潔に読み上げてください．" +
      "文と文はなめらかに繋ぎ，句読点で不自然に間を空けず，流暢で自然な語りにしてください．" +
      "過度な感情表現は抑え，丁寧で信頼感のある落ち着いた声にしてください．",
  };
}

export class ClaudeClient {
  private client: Anthropic;

  constructor(apiKey: string = config.anthropicApiKey) {
    this.client = new Anthropic({ apiKey });
  }

  /**
   * 会話履歴から応答を生成する. tool_use があれば実行して継続するエージェントループ.
   * テキストデルタは onText で逐次通知し, 呼び出し側が文単位でTTSへ流せるようにする.
   * 返り値は最終応答テキスト（履歴保存用）.
   */
  /**
   * 常時聞き取った発話が「谺へ向けられ, 応答を期待しているか」を高速モデルで判定する.
   * 併せて, 回答に必要な履歴の遡り範囲（直近メッセージ数）も判定して返す.
   * 複数人の雑談で谺宛でないものには respond=false を返し, 介入を避ける.
   */
  async classifyTurn(opts: {
    recent: MessageRecord[];
    utterance: string;
    name?: string;
  }): Promise<{ respond: boolean; contextWindow: number; reason?: string }> {
    const fallback = {
      respond: false,
      contextWindow: config.contextWindowDefault,
    };
    const a = opts.name || config.assistantName; // アシスタント名（任意設定）
    const recentText =
      opts.recent
        .slice(-12)
        .map((m) => `${m.role === "assistant" ? a : "人"}: ${m.text}`)
        .join("\n") || "(履歴なし)";
    const system =
      `あなたはAI秘書「${a}」の発話制御judgeです．${a}は研究居室に常駐し，マイクで` +
      "周囲の音声を常時聞き取っています（その場に複数人いることもあります）．\n" +
      `与えられた『最新発話』に対し，${a}が今すぐ声で応答すべきかを判定してください．\n` +
      `原則: ${a}へ明確に向けられ，応答を期待している発話だけ respond=true とします．\n` +
      `・「${a}」等の呼びかけ，${a}への質問・依頼・命令は respond=true．\n` +
      `・直近で${a}が応答に加わっており（直前が${a}の発話など），最新発話がそれを受けた自然な` +
      "続き（追加の質問・確認・指示）なら，呼びかけが無くても継続中の1対1対話として respond=true．\n" +
      `・直近が人どうしの会話だけで${a}が関与していないなら，呼びかけが無い限り respond=false．\n` +
      `・独り言・相づち・${a}宛でない雑談は respond=false（黙って聞くだけ）．\n` +
      `迷う場合は，直前が${a}の発話なら respond=true 寄り，そうでなければ respond=false 寄りに判断します．\n` +
      "context_window は，この発話に答えるために遡るべき直近メッセージ数を" +
      `${config.contextWindowMin}〜${config.contextWindowMax}で見積もります（自己完結なら小さく，` +
      "前の話題を受けるなら大きく）．\n" +
      '出力はJSONのみ: {"respond": true/false, "context_window": 整数, "reason": "短い理由"}';
    const user = `直近の会話:\n${recentText}\n\n最新発話:\n「${opts.utterance}」`;
    try {
      const msg = await this.client.messages.create({
        model: config.fastModel,
        max_tokens: 200,
        temperature: 0,
        system,
        messages: [{ role: "user", content: user }],
      });
      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return fallback;
      const j = JSON.parse(m[0]) as {
        respond?: boolean;
        context_window?: number;
        reason?: string;
      };
      return {
        respond: !!j.respond,
        contextWindow: Number(j.context_window) || config.contextWindowDefault,
        reason: j.reason,
      };
    } catch {
      return fallback;
    }
  }

  async converse(opts: {
    history: MessageRecord[];
    toolContext: ToolContext;
    instructions?: string;
    model?: string;
    signal?: AbortSignal;
    onText?: (delta: string) => void;
    onTool?: (name: string) => void;
  }): Promise<string> {
    const messages: Anthropic.MessageParam[] = opts.history
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.text,
      }));

    let finalText = "";

    for (let guard = 0; guard < 6; guard++) {
      if (opts.signal?.aborted) break;
      const stream = this.client.messages.stream(
        {
          model: opts.model ?? config.brainModel,
          max_tokens: 1024,
          system: opts.instructions ?? buildInstructions(defaultPersona()),
          tools: TOOL_DEFS,
          messages,
        },
        { signal: opts.signal },
      );

      if (opts.onText) {
        stream.on("text", (delta: string) => opts.onText?.(delta));
      }
      // サーバサイドWeb検索の開始を捉えてUIへ「Web検索中…」を出す.
      stream.on("streamEvent", (ev) => {
        if (
          ev.type === "content_block_start" &&
          ev.content_block.type === "server_tool_use" &&
          ev.content_block.name === "web_search"
        ) {
          opts.onTool?.("web_search");
        }
      });

      let msg: Anthropic.Message;
      try {
        msg = await stream.finalMessage();
      } catch (e) {
        // 停止（バージイン/停止ボタン）でストリームが中断されたら, ここまでで打ち切る.
        if (opts.signal?.aborted) break;
        throw e;
      }

      finalText = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      const toolUses = msg.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      if (msg.stop_reason !== "tool_use" || toolUses.length === 0) {
        break;
      }

      // ツール実行 → 結果を会話に戻して継続
      messages.push({ role: "assistant", content: msg.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        opts.onTool?.(tu.name);
        const out = await runTool(tu.name, tu.input, opts.toolContext);
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: out,
        });
      }
      messages.push({ role: "user", content: results });
    }

    return finalText;
  }
}
