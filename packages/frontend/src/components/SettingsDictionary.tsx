import { useEffect, useState } from "react";
import type { TermRecord } from "@kodama/shared";

/** 発音辞書の1エントリ（backend の LexEntry と同形） */
interface LexEntry {
  surface: string;
  reading: string;
}

const KIND_LABEL: Record<string, string> = {
  person: "人物",
  project: "プロジェクト",
  jargon: "専門語",
  place: "場所",
  other: "その他",
};

/**
 * 辞書の編集タブ. 発音辞書（TTSの読み）と語彙（STT認識ヒント）を一覧・追加・削除できる.
 * すべてREST（/api/lexicon, /api/terms）経由でDBへ即時反映され,
 * 読み上げ・音声認識には次の発話から効く.
 */
export function SettingsDictionary() {
  const [lexicon, setLexicon] = useState<LexEntry[] | null>(null);
  const [terms, setTerms] = useState<TermRecord[] | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // 追加フォーム（発音辞書）
  const [lexSurface, setLexSurface] = useState("");
  const [lexReading, setLexReading] = useState("");
  // 追加フォーム（語彙）
  const [termSurface, setTermSurface] = useState("");
  const [termReading, setTermReading] = useState("");
  const [termKind, setTermKind] = useState("jargon");

  useEffect(() => {
    let alive = true;
    fetch("/api/lexicon")
      .then((r) => r.json())
      .then((l: LexEntry[]) => alive && setLexicon(l))
      .catch(() => alive && setError("辞書を取得できませんでした（バックエンド未接続）"));
    fetch("/api/terms")
      .then((r) => r.json())
      .then((t: TermRecord[]) => alive && setTerms(t))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const addLex = async () => {
    if (!lexSurface.trim() || !lexReading.trim()) return;
    try {
      const l = (await fetch("/api/lexicon", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ surface: lexSurface, reading: lexReading }),
      }).then((r) => r.json())) as LexEntry[];
      setLexicon(l);
      setLexSurface("");
      setLexReading("");
      setMsg({ ok: true, text: "読みを登録しました" });
    } catch {
      setMsg({ ok: false, text: "登録に失敗しました" });
    }
  };

  const removeLex = async (surface: string) => {
    try {
      await fetch(`/api/lexicon?surface=${encodeURIComponent(surface)}`, {
        method: "DELETE",
      });
      setLexicon((prev) => prev?.filter((e) => e.surface !== surface) ?? null);
    } catch {
      setMsg({ ok: false, text: "削除に失敗しました" });
    }
  };

  const addTerm = async () => {
    if (!termSurface.trim()) return;
    try {
      const t = (await fetch("/api/terms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          surface: termSurface,
          reading: termReading.trim() || null,
          kind: termKind,
        }),
      }).then((r) => r.json())) as TermRecord[];
      setTerms(t);
      setTermSurface("");
      setTermReading("");
      setMsg({ ok: true, text: "語彙を登録しました（読み付きは発音辞書へも反映）" });
      // 読み付き語彙は発音辞書にも反映されるため一覧を取り直す.
      fetch("/api/lexicon")
        .then((r) => r.json())
        .then((l: LexEntry[]) => setLexicon(l))
        .catch(() => {});
    } catch {
      setMsg({ ok: false, text: "登録に失敗しました" });
    }
  };

  const toggleTerm = async (t: TermRecord) => {
    try {
      const list = (await fetch("/api/terms", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ surface: t.surface, active: !t.active }),
      }).then((r) => r.json())) as TermRecord[];
      setTerms(list);
    } catch {
      setMsg({ ok: false, text: "切り替えに失敗しました" });
    }
  };

  const removeTerm = async (surface: string) => {
    try {
      await fetch(`/api/terms?surface=${encodeURIComponent(surface)}`, {
        method: "DELETE",
      });
      setTerms((prev) => prev?.filter((t) => t.surface !== surface) ?? null);
    } catch {
      setMsg({ ok: false, text: "削除に失敗しました" });
    }
  };

  if (error) return <p className="settings-error">{error}</p>;
  if (!lexicon) return <p className="settings-hint">読み込み中…</p>;

  return (
    <>
      <section className="settings-row">
        <label>発音辞書（読み上げの読み）</label>
        <p className="settings-hint" style={{ margin: "0 0 8px" }}>
          固有名詞の読み誤りを防ぎます．読み上げ（TTS）の直前に表記を読みへ置換します．
        </p>
        <ul className="dict-list">
          {lexicon.map((e) => (
            <li className="dict-item" key={e.surface}>
              <span className="dict-surface">{e.surface}</span>
              <span className="dict-reading">{e.reading}</span>
              <button
                className="dict-delete"
                onClick={() => void removeLex(e.surface)}
                title="削除"
              >
                ✕
              </button>
            </li>
          ))}
          {lexicon.length === 0 && (
            <li className="dict-item empty">登録がありません</li>
          )}
        </ul>
        <div className="settings-control dict-add">
          <input
            type="text"
            value={lexSurface}
            onChange={(e) => setLexSurface(e.target.value)}
            placeholder="表記（例: 油谷）"
          />
          <input
            type="text"
            value={lexReading}
            onChange={(e) => setLexReading(e.target.value)}
            placeholder="読み（例: あぶらたに）"
          />
          <button
            onClick={() => void addLex()}
            disabled={!lexSurface.trim() || !lexReading.trim()}
          >
            追加
          </button>
        </div>
      </section>

      <section className="settings-row">
        <label>語彙（音声認識のヒント）</label>
        <p className="settings-hint" style={{ margin: "0 0 8px" }}>
          固有名詞・専門語を音声認識（whisper）へ誘導し，聞き取り精度を底上げします．
          チェックを外すとヒントから除外されます（登録は残ります）．
        </p>
        <ul className="dict-list">
          {(terms ?? []).map((t) => (
            <li className={`dict-item ${t.active ? "" : "inactive"}`} key={t.id}>
              <input
                type="checkbox"
                checked={t.active}
                onChange={() => void toggleTerm(t)}
                title="音声認識ヒントに載せる"
              />
              <span className="dict-surface">{t.surface}</span>
              <span className="dict-reading">{t.reading ?? ""}</span>
              <span className="dict-kind">{KIND_LABEL[t.kind] ?? t.kind}</span>
              <button
                className="dict-delete"
                onClick={() => void removeTerm(t.surface)}
                title="削除"
              >
                ✕
              </button>
            </li>
          ))}
          {(terms ?? []).length === 0 && (
            <li className="dict-item empty">登録がありません</li>
          )}
        </ul>
        <div className="settings-control dict-add">
          <input
            type="text"
            value={termSurface}
            onChange={(e) => setTermSurface(e.target.value)}
            placeholder="表記（例: 谺）"
          />
          <input
            type="text"
            value={termReading}
            onChange={(e) => setTermReading(e.target.value)}
            placeholder="読み（任意）"
          />
          <select value={termKind} onChange={(e) => setTermKind(e.target.value)}>
            {Object.entries(KIND_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <button onClick={() => void addTerm()} disabled={!termSurface.trim()}>
            追加
          </button>
        </div>
      </section>

      {msg && (
        <p className={`settings-result ${msg.ok ? "ok" : "ng"}`}>{msg.text}</p>
      )}
    </>
  );
}
