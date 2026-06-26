import { config } from "../../config.js";

const NOTION_VERSION = "2022-06-28";
const API = "https://api.notion.com/v1";

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.notionToken}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

/** ページ/DBオブジェクトからタイトル文字列を取り出す. */
function extractTitle(obj: any): string {
  const props = obj?.properties ?? {};
  for (const key of Object.keys(props)) {
    const p = props[key];
    if (p?.type === "title" && Array.isArray(p.title)) {
      const t = p.title.map((x: any) => x.plain_text).join("");
      if (t) return t;
    }
  }
  // データベース自体は obj.title にタイトルを持つ
  if (Array.isArray(obj?.title)) return obj.title.map((x: any) => x.plain_text).join("");
  return "(無題)";
}

/** Notion 全体を検索し, ヒットしたページ/DBの一覧を返す. */
export async function notionSearch(query: string, limit = 10): Promise<string> {
  const res = await fetch(`${API}/search`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ query, page_size: limit }),
  });
  if (!res.ok) throw new Error(`Notion検索失敗 (${res.status})`);
  const data: any = await res.json();
  const items = (data.results ?? []).map((r: any) => ({
    id: r.id,
    title: extractTitle(r),
    type: r.object,
    url: r.url,
  }));
  if (!items.length) return "該当するNotionページはありませんでした．";
  return JSON.stringify(items, null, 0);
}

/** ブロックを素朴にテキスト化する. */
function blockText(block: any): string {
  const t = block?.type;
  const rich = block?.[t]?.rich_text;
  if (Array.isArray(rich)) return rich.map((x: any) => x.plain_text).join("");
  return "";
}

/** テキストを段落ブロック配列へ（改行で分割, Notionのテキスト上限を考慮）. */
function toParagraphs(text: string): unknown[] {
  return text.split("\n").map((line) => ({
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: line
        ? [{ type: "text", text: { content: line.slice(0, 1900) } }]
        : [],
    },
  }));
}

/** 既存ページ/ブロックの末尾にテキスト（段落）を追記する. */
export async function notionAppend(pageId: string, text: string): Promise<string> {
  const res = await fetch(`${API}/blocks/${pageId}/children`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ children: toParagraphs(text) }),
  });
  if (!res.ok) {
    throw new Error(`Notion追記失敗 (${res.status}: ${await res.text()})`);
  }
  return "追記しました．";
}

/** 親ページの下に新しいサブページを作成する（本文は任意）. */
export async function notionCreatePage(
  parentPageId: string,
  title: string,
  content = "",
): Promise<string> {
  const res = await fetch(`${API}/pages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      parent: { page_id: parentPageId },
      properties: {
        title: { title: [{ type: "text", text: { content: title } }] },
      },
      ...(content ? { children: toParagraphs(content) } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`Notionページ作成失敗 (${res.status}: ${await res.text()})`);
  }
  const data: any = await res.json();
  return `ページ「${title}」を作成しました．（id=${data.id}）`;
}

/** ページ本文（直下ブロック）を取得してテキストで返す. */
export async function notionGetPage(pageId: string, maxChars = 6000): Promise<string> {
  const res = await fetch(
    `${API}/blocks/${pageId}/children?page_size=100`,
    { headers: headers() },
  );
  if (!res.ok) throw new Error(`Notionページ取得失敗 (${res.status})`);
  const data: any = await res.json();
  const text = (data.results ?? [])
    .map(blockText)
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!text) return "本文が空か, 取得できませんでした．";
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…(以下省略)" : text;
}
