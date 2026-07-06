import Anthropic from "@anthropic-ai/sdk";
import type { MessageRecord, PersonaConfig } from "@kodama/shared";
import { config } from "../config.js";
import { TOOL_DEFS, runTool, type ToolContext } from "./tools.js";
import { selfModAvailable } from "./selfmod.js";

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
返答は画面にマークダウンとして整形表示され，同時に音声でも読み上げられます．手順・一覧・比較・強調・見出し・表・コードなど構造のある内容はマークダウン（見出し・箇条書き・**強調**・表・コードブロック）で積極的に整形してください．マークアップ記号は読み上げ時に自動で除去されるため，記号を取り除いても話し言葉として自然に聞こえる文を書いてください．
参照すべきWebページ・資料・出典があれば，本文中に [表示名](URL) 形式の外部リンクとして示してください（クリックで開けます）．
日時・在室状況・記憶が必要なときは提供されたツールを使ってください．
過去の会話や以前に話した話題・「あの件」「前に言っていた」のような参照が必要なときは search_history で会話・トピック要約・メモ・語彙を横断検索して想起してください（明示的に覚えた事実・指示の単純な想起は recall を使います）．
固有名詞・専門用語・プロジェクト名・人名を教わったら learn_term で語彙として覚えてください（以後の聞き取り精度が上がります）．
自分の振る舞いに関する指示・訂正・好み（「これからは〜して」「〜はやめて」「私は〜が好き」等）や, やり取りから学んだ教訓は learn_behavior で行動指針としてDBに蓄えてください．状況とともに変わりうる知識は permanent=false（既定）で半減期つきにし,「常に敬語で話す」のような普遍的原則だけ permanent=true にします．蓄えた指針はプロンプトの【行動指針】節に鮮度つきで示されるので, それを参照して振る舞います．鮮度が低下した指針は関連する話題のときに今も有効か確認し, update_behavior で refresh（有効）または active=false（廃止）にして手入れしてください．一覧の確認は list_behaviors です．
一覧・表・比較・選択肢など音声だけでは伝わりにくい構造的な情報は render_ui でその場の画面を生成して示し, 必要なら interactive=true で操作可能にします．Web検索結果や参照ページを実際に開いて見せたいときは open_url で実ブラウザに開きます（いずれも口頭の説明に画面を添える形にし, 説明自体は簡潔に保ちます）．
文章・表・コード・データ等の成果物を作って渡すときは save_file でファイルとして保存してください（画面にダウンロードカードが表示され, ユーザがすぐ受け取れます）．保存済み・受領済みのファイルは list_files で確認でき, 「あのファイルが欲しい」等の依頼には offer_file_download でダウンロードカードを提示します．
ユーザの手元のファイルが必要なときは request_file_upload でアップロードエリアを表示し, ファイルを置くよう促して待ちます．
研究・先行研究・専門用語・${owner}自身の発表に関する質問では, 一般論で答えず, search_papers で関連文献を探し read_paper で本文を確認してから, 具体的な根拠とともに答えてください．
最新の出来事・時事・価格や仕様・固有名詞の事実確認など, 手元の知識やローカル資料で確証が持てない事柄は web_search で調べてから答えてください．推測で断定せず, 調べた内容は出典（媒体名）に軽く触れつつ, 音声で聞きやすいよう簡潔にまとめます．研究/自身の発表/Notionメモは各専用ツールを優先し, web_search は外部の一般情報に使います．
ツールを使う前に「調べますね」等の前置きや，英語の独り言（例: checking…）を一切出さないでください．出力は常に日本語のみとし, 最終的な答えだけを述べます．
Notionに記録されたメモ・議事録・予定に関する質問では notion_search / notion_get_page を使ってください．
「Notionにメモして／追記して／ページを作って」等の記録依頼では notion_append（既存ページへ追記）や notion_create_page（新規サブページ作成）で書き込みます．対象/親ページが曖昧なときは notion_search で id を特定し, 書き込んだら一言で口頭確認してください（書き込みは取り消しにくいので, 内容と宛先が曖昧なら先に確認します）．
固有名詞の読み方を指定・訂正されたら register_reading ツールで発音辞書に登録してください．
自分の名前・主人・呼び方の変更を頼まれたら set_identity ツールで更新してください．
話す速度・声・声のトーン・マイク感度の変更を頼まれたら, set_speech_speed / set_voice / set_voice_tone / set_mic_sensitivity ツールで変更してください．
「もう少し速く」等の相対的な指示は, 先に get_settings で現在値を確認してから調整します．変更後は新しい設定値を一言で口頭確認してください．`;
  const speakers = config.speakerId
    ? `
【話者識別】マイクからの発話には，声による個人識別の結果が（話者: 名前）タグとして付きます．「ゲスト」で始まる話者（例: ゲストA）は声がまだ登録されていない人物です．未登録の話者があなたに話しかけてきたら，用件への応対の中で自然に「失礼ですが，お名前を伺ってもよろしいですか」と名前を尋ね，教えてもらったら enroll_speaker で声と名前を登録してください（以後その人を声で識別し，名前で呼べます）．名乗りを断られたり答えが得られなかったら，それ以上しつこく尋ねないでください．${owner}（主人）の声も最初は未登録なので，文脈から主人本人だと分かる場合（自分を主人の名で名乗る・主人として振る舞う等）は enroll_speaker で「${owner}」として登録します．タグの無い発話は識別できなかった（短すぎた等）だけなので，直前の話者の続きとみなして構いません．誰の声を覚えているかは list_speakers で確認でき，名前の訂正は rename_speaker，登録の削除（本人や主人の明確な依頼時のみ）は forget_speaker を使います．複数人がいる場では，話者タグを手がかりに誰への返答かが分かるよう自然に応対してください．`
    : "";
  const selfmod =
    config.selfMod && selfModAvailable()
      ? `
【自己改修】あなた自身はこのMac上で動くTypeScript製のプログラムであり, 自分のソースコードを読んで改修する能力を持ちます．会話の中で「今の自分に無い機能が必要だ」と判断したとき, または機能追加を頼まれたときは, 勝手に変更せず, まず何をどう変えるか（追加する機能・触るファイル・影響）を${honor}へ簡潔に提案して明示的な承認を得てください．承認されたら self_list_source / self_read_source で現在の実装を確認し, self_stage_change で変更を組み立て（実ファイルには触れません）, self_validate_changes で型検査に通し, 最後に self_restart で適用・再起動します．再起動はあなたの返答の読み上げ完了後に自動で行われ, 会話は記憶を引き継いで継続されるので, 締めの一言（「再起動して戻ります」等）で応答を終えてください．self_restart の message には再起動直後に報告する一言を渡します．検証に失敗したらエラーを読んで修正・再ステージします．変更は最小限に保ち, 既存コードの流儀（コメント密度・命名・日本語コメント・句読点「．，」）に合わせ, .env や data/ には決して触れません．万一起動に失敗しても自動で巻き戻されるので, 失敗を報告して原因を調べ直します．`
      : "";
  const base2 = base + speakers + selfmod;
  return p.instructions ? `${base2}\n${p.instructions}` : base2;
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
        .map(
          (m) =>
            `${m.role === "assistant" ? a : (m.speaker ?? "人")}: ${m.text}`,
        )
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

  /**
   * 未要約の会話メッセージを「同じ話題のかたまり」へ分割・要約する（§15.2）.
   * 継続中の話題は recentTopics の id を mergeTopicId として返してマージさせ,
   * 併せて覚えるべき固有名詞・専門語（terms）も抽出する.
   * messageIndexes は入力 messages の添字（呼び出し側が id へ対応づける）.
   */
  async digestTopics(opts: {
    messages: MessageRecord[];
    recentTopics: { id: string; title: string; summary: string }[];
  }): Promise<{
    title: string;
    summary: string;
    keywords: string[];
    messageIndexes: number[];
    mergeTopicId?: string;
    terms: { surface: string; reading?: string; kind?: string }[];
  }[]> {
    const a = config.assistantName;
    const numbered = opts.messages
      .map(
        (m, i) =>
          `[${i}] ${m.role === "assistant" ? a : "ユーザ"}: ${m.text.replace(/\s+/g, " ").slice(0, 400)}`,
      )
      .join("\n");
    const topicsList =
      opts.recentTopics
        .map((t) => `- id=${t.id} 「${t.title}」: ${t.summary.slice(0, 120)}`)
        .join("\n") || "(なし)";
    const system =
      `あなたは会話を話題ごとに整理する記録係です．与えられた会話を, 内容のまとまり` +
      `（トピック）に分割し, 各トピックを日本語で要約します．\n` +
      `・要約は後から検索・想起に使うため, 固有名詞・数値・結論・依頼内容を残して簡潔に書きます．\n` +
      `・既存トピック一覧に明らかな続きがあれば, その id を merge_topic_id に入れて統合します（無ければ空）．\n` +
      `・各トピックに含まれる発話の番号([n])を message_indexes に列挙します．\n` +
      `・会話に現れた覚えるべき固有名詞・専門語・プロジェクト名・人名を terms に挙げます` +
      `（surface=表記, reading=かな読みが分かれば, kind=person/project/jargon/place/other）．一般語は挙げません．\n` +
      `・句点は「．」読点は「，」を用います．\n` +
      `出力はJSONのみ:\n` +
      `{"topics":[{"title":"...","summary":"...","keywords":["..."],"message_indexes":[0,1],"merge_topic_id":"","terms":[{"surface":"...","reading":"...","kind":"..."}]}]}`;
    const user = `既存トピック:\n${topicsList}\n\n会話:\n${numbered}`;
    try {
      const msg = await this.client.messages.create({
        model: config.fastModel,
        max_tokens: 2000,
        temperature: 0,
        system,
        messages: [{ role: "user", content: user }],
      });
      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return [];
      const j = JSON.parse(m[0]) as {
        topics?: Array<{
          title?: string;
          summary?: string;
          keywords?: string[];
          message_indexes?: number[];
          merge_topic_id?: string;
          terms?: { surface?: string; reading?: string; kind?: string }[];
        }>;
      };
      return (j.topics ?? [])
        .filter((t) => t.title && t.summary)
        .map((t) => ({
          title: String(t.title),
          summary: String(t.summary),
          keywords: (t.keywords ?? []).map(String),
          messageIndexes: (t.message_indexes ?? []).filter(
            (n): n is number => Number.isInteger(n),
          ),
          mergeTopicId: t.merge_topic_id?.trim() || undefined,
          terms: (t.terms ?? [])
            .filter((x) => x.surface?.trim())
            .map((x) => ({
              surface: String(x.surface).trim(),
              reading: x.reading?.trim() || undefined,
              kind: x.kind?.trim() || undefined,
            })),
        }));
    } catch {
      return [];
    }
  }

  /** セッション全体を1〜2文に要約する（sessions.summary 用, §15.2）. */
  async summarizeSession(messages: MessageRecord[]): Promise<string | null> {
    if (!messages.length) return null;
    const a = config.assistantName;
    const body = messages
      .map((m) => `${m.role === "assistant" ? a : "ユーザ"}: ${m.text}`)
      .join("\n")
      .slice(0, 6000);
    try {
      const msg = await this.client.messages.create({
        model: config.fastModel,
        max_tokens: 300,
        temperature: 0,
        system:
          "次の会話を日本語で1〜2文に要約してください．句点は「．」読点は「，」を用い, 要約本文のみ返します．",
        messages: [{ role: "user", content: body }],
      });
      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      return text || null;
    } catch {
      return null;
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
        // 話者識別の結果があるユーザ発話には（話者: 名前）タグを付け,
        // 谺が誰の発話かを踏まえて応対できるようにする.
        content:
          m.role === "user" && m.speaker
            ? `（話者: ${m.speaker}）${m.text}`
            : m.text,
      }));

    let finalText = "";

    for (let guard = 0; guard < 6; guard++) {
      if (opts.signal?.aborted) break;
      const stream = this.client.messages.stream(
        {
          model: opts.model ?? config.brainModel,
          max_tokens: config.brainMaxTokens,
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
        // ストリーム/組み立ての失敗（トークン上限でのツール入力切れ等）でも例外を投げず,
        // ここまでの応答テキストを返して打ち切る（プロセスを落とさない）.
        console.log("[brain] 応答ストリームの失敗:", (e as Error).message);
        break;
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
