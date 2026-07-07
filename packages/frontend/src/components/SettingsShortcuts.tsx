import { useEffect, useState } from "react";
import { DEFAULT_SHORTCUTS, type ShortcutSettings } from "@kodama/shared";
import { eventToAccelerator, formatAccelerator } from "../shortcuts.js";

/** ショートカット1項目の定義（キーと説明） */
const ITEMS: { key: keyof ShortcutSettings; label: string; hint: string }[] = [
  {
    key: "openSettings",
    label: "設定画面を開く",
    hint: "どのアプリを使っていても谺を前面に出して設定画面を開きます",
  },
  {
    key: "hearing",
    label: "ヒアリングモード",
    hint: "傾聴を開始します．谺の発話中はカットイン（割り込み）します",
  },
];

/**
 * グローバルショートカットの編集タブ. 入力欄をクリック→キーを押すだけで録画され,
 * 即座にバックエンドへ保存・配信される（Electronが再登録するため再起動不要）.
 */
export function SettingsShortcuts() {
  const [shortcuts, setShortcuts] = useState<ShortcutSettings | null>(null);
  const [recording, setRecording] = useState<keyof ShortcutSettings | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/shortcuts")
      .then((r) => r.json())
      .then((s: ShortcutSettings) => alive && setShortcuts(s))
      .catch(
        () =>
          alive &&
          setMsg({ ok: false, text: "設定を取得できませんでした（バックエンド未接続）" }),
      );
    return () => {
      alive = false;
    };
  }, []);

  const save = async (patch: Partial<ShortcutSettings>) => {
    setMsg(null);
    try {
      const next = (await fetch("/api/shortcuts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }).then((r) => r.json())) as ShortcutSettings;
      setShortcuts(next);
      setMsg({ ok: true, text: "保存しました（即時に有効です）" });
    } catch {
      setMsg({ ok: false, text: "保存に失敗しました" });
    }
  };

  const onKeyDown = (item: keyof ShortcutSettings) => (e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setRecording(null);
      return;
    }
    const accel = eventToAccelerator(e.nativeEvent);
    if (!accel) return; // 修飾キー単独・非対応キーは無視して録画を続ける
    setRecording(null);
    void save({ [item]: accel });
  };

  if (!shortcuts) {
    return <p className="settings-hint">{msg?.text ?? "読み込み中…"}</p>;
  }

  return (
    <>
      <p className="settings-hint" style={{ marginBottom: 14 }}>
        入力欄をクリックしてキーを押すと登録されます（Esc でキャンセル）．
        変更はすぐに反映され，他のアプリを使用中でも効きます．
      </p>
      {ITEMS.map((item) => (
        <section className="settings-row" key={item.key}>
          <label>{item.label}</label>
          <div className="settings-control">
            <button
              type="button"
              className={`shortcut-capture ${recording === item.key ? "recording" : ""}`}
              onClick={() => setRecording(item.key)}
              onKeyDown={recording === item.key ? onKeyDown(item.key) : undefined}
              onBlur={() => setRecording((r) => (r === item.key ? null : r))}
            >
              {recording === item.key ? (
                <span className="shortcut-waiting">キーを押してください…</span>
              ) : (
                <kbd>{formatAccelerator(shortcuts[item.key])}</kbd>
              )}
            </button>
            <button
              type="button"
              onClick={() => void save({ [item.key]: DEFAULT_SHORTCUTS[item.key] })}
              disabled={shortcuts[item.key] === DEFAULT_SHORTCUTS[item.key]}
              title={`既定（${formatAccelerator(DEFAULT_SHORTCUTS[item.key])}）に戻す`}
            >
              既定に戻す
            </button>
          </div>
          <p className="settings-hint">{item.hint}</p>
        </section>
      ))}
      {msg && (
        <p className={`settings-result ${msg.ok ? "ok" : "ng"}`}>{msg.text}</p>
      )}
    </>
  );
}
