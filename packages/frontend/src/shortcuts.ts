/**
 * グローバルショートカットのアクセラレータ文字列（Electron Accelerator形式）を扱う.
 * - 設定画面のキー録画（KeyboardEvent → "CommandOrControl+," 等）
 * - Web UI内でのキー照合（ブラウザ単体で開いた場合のフォールバック）
 * - 表示用の整形（"⌘ ," 等）
 */

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform);

/** KeyboardEvent.code → アクセラレータのキー名（対応外は null） */
export function keyFromCode(code: string): string | null {
  if (code.startsWith("Key")) return code.slice(3); // KeyT → "T"
  if (code.startsWith("Digit")) return code.slice(5); // Digit1 → "1"
  if (/^F\d{1,2}$/.test(code)) return code; // F1〜F24
  const map: Record<string, string> = {
    Comma: ",",
    Period: ".",
    Slash: "/",
    Semicolon: ";",
    Quote: "'",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    Space: "Space",
    Enter: "Enter",
    Tab: "Tab",
    Escape: "Esc",
    Backspace: "Backspace",
    Delete: "Delete",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
  };
  return map[code] ?? null;
}

/**
 * キー押下からアクセラレータ文字列を組み立てる（設定画面のキー録画用）.
 * 修飾キー単独や, 修飾キー無しの通常キー（誤爆しやすい）は null を返す.
 */
export function eventToAccelerator(e: KeyboardEvent): string | null {
  const key = keyFromCode(e.code);
  if (!key) return null;
  const mods: string[] = [];
  if (e.metaKey) mods.push("Command");
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  // グローバルに奪うため, Fキー以外は修飾キー必須にする.
  if (!mods.length && !/^F\d{1,2}$/.test(key)) return null;
  return [...mods, key].join("+");
}

interface ParsedAccel {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

/** アクセラレータ文字列を分解する（CommandOrControl はプラットフォームで解決）. */
function parse(accel: string): ParsedAccel | null {
  const parts = accel.split("+").filter(Boolean);
  if (!parts.length) return null;
  const p: ParsedAccel = { meta: false, ctrl: false, alt: false, shift: false, key: "" };
  for (const raw of parts) {
    switch (raw.toLowerCase()) {
      case "commandorcontrol":
      case "cmdorctrl":
        if (IS_MAC) p.meta = true;
        else p.ctrl = true;
        break;
      case "command":
      case "cmd":
      case "super":
      case "meta":
        p.meta = true;
        break;
      case "control":
      case "ctrl":
        p.ctrl = true;
        break;
      case "alt":
      case "option":
        p.alt = true;
        break;
      case "shift":
        p.shift = true;
        break;
      default:
        p.key = raw;
    }
  }
  return p.key ? p : null;
}

/** キーイベントがアクセラレータに一致するか（修飾キーは完全一致）. */
export function matchAccelerator(accel: string, e: KeyboardEvent): boolean {
  const p = parse(accel);
  if (!p) return false;
  if (e.metaKey !== p.meta || e.ctrlKey !== p.ctrl) return false;
  if (e.altKey !== p.alt || e.shiftKey !== p.shift) return false;
  const key = keyFromCode(e.code);
  return !!key && key.toLowerCase() === p.key.toLowerCase();
}

/** 表示用に修飾キーを記号へ置き換える（例: "⌘ ,"）. */
export function formatAccelerator(accel: string): string {
  const p = parse(accel);
  if (!p) return accel;
  const mods = [
    p.ctrl ? "⌃" : "",
    p.alt ? "⌥" : "",
    p.shift ? "⇧" : "",
    p.meta ? "⌘" : "",
  ].join("");
  return `${mods} ${p.key.toUpperCase()}`.trim();
}
