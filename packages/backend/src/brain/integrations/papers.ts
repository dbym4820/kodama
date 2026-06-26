import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { config } from "../../config.js";

const TEXT_EXT = new Set([".txt", ".md", ".markdown", ".tex"]);
const PDF_EXT = new Set([".pdf"]);

/** papersDir 配下の対象ファイル（相対パス）を列挙する. */
function listFiles(): string[] {
  try {
    return (
      readdirSync(config.papersDir, {
        recursive: true,
        encoding: "utf8",
      }) as string[]
    ).filter((p) => {
      const e = extname(p).toLowerCase();
      return TEXT_EXT.has(e) || PDF_EXT.has(e);
    });
  } catch {
    return [];
  }
}

/**
 * 研究文献をファイル名・フォルダ名（日本語タイトル）で検索する.
 * クエリ語の一致数でスコアリングし, 上位を返す.
 */
export function searchPapers(query: string, limit = 15): string[] {
  const tokens = query
    .toLowerCase()
    .split(/[\s,、，・]+/)
    .filter(Boolean);
  if (!tokens.length) return [];
  return listFiles()
    .map((rel) => {
      const hay = rel.toLowerCase();
      const score = tokens.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
      return { rel, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.rel);
}

/** 文献の本文テキストを取得する（PDFは pdftotext で抽出）. */
export async function readPaper(relPath: string, maxChars = 6000): Promise<string> {
  const base = resolve(config.papersDir);
  const full = resolve(base, relPath);
  // パストラバーサル防止: papersDir 配下に限定.
  if (full !== base && !full.startsWith(base + sep)) {
    return "指定パスは参照範囲外です．";
  }
  const ext = extname(full).toLowerCase();
  let text = "";
  if (PDF_EXT.has(ext)) {
    text = await pdfToText(full);
  } else {
    try {
      text = readFileSync(full, "utf8");
    } catch {
      return "ファイルを読めませんでした．";
    }
  }
  text = text.trim();
  if (!text) return "本文を抽出できませんでした．";
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…(以下省略)" : text;
}

function pdfToText(path: string): Promise<string> {
  return new Promise((res) => {
    const p = spawn("pdftotext", ["-enc", "UTF-8", "-q", path, "-"]);
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.on("error", () => res(""));
    p.on("close", () => res(out));
  });
}
