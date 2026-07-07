import { useEffect, useState } from "react";
import type { SpeakerRecord } from "@kodama/shared";

/**
 * 認識済みユーザ（登録話者）の編集タブ. 声で個人識別する相手の一覧を表示し,
 * 名前・読みの変更と削除（声を忘れる）ができる. 変更はREST経由でDBへ即時反映され,
 * 話者識別器の照合プロファイルも同時に更新される.
 */
export function SettingsSpeakers() {
  const [speakers, setSpeakers] = useState<SpeakerRecord[] | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // 行ごとの編集内容（元の名前 → 入力中の名前・読み）
  const [edits, setEdits] = useState<Record<string, { name: string; reading: string }>>(
    {},
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/speakers")
      .then((r) => r.json())
      .then((s: SpeakerRecord[]) => alive && setSpeakers(s))
      .catch(() => alive && setError("話者一覧を取得できませんでした（バックエンド未接続）"));
    return () => {
      alive = false;
    };
  }, []);

  const editOf = (s: SpeakerRecord) =>
    edits[s.id] ?? { name: s.name, reading: s.reading ?? "" };

  const setEdit = (s: SpeakerRecord, patch: Partial<{ name: string; reading: string }>) => {
    setEdits((prev) => ({ ...prev, [s.id]: { ...editOf(s), ...patch } }));
    setMsg(null);
  };

  const rename = async (s: SpeakerRecord) => {
    const e = editOf(s);
    if (!e.name.trim()) {
      setMsg({ ok: false, text: "名前を入力してください" });
      return;
    }
    setBusy(true);
    try {
      const r = (await fetch("/api/speakers", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: s.name,
          newName: e.name.trim(),
          reading: e.reading.trim() || null,
        }),
      }).then((x) => x.json())) as { ok: boolean; speakers: SpeakerRecord[] };
      setSpeakers(r.speakers);
      setEdits((prev) => {
        const { [s.id]: _drop, ...rest } = prev;
        return rest;
      });
      setMsg(
        r.ok
          ? { ok: true, text: `「${e.name.trim()}」として保存しました` }
          : { ok: false, text: "変更に失敗しました" },
      );
    } catch {
      setMsg({ ok: false, text: "変更に失敗しました" });
    } finally {
      setBusy(false);
    }
  };

  const forget = async (s: SpeakerRecord) => {
    if (!window.confirm(`「${s.name}」さんの声の登録を削除しますか？`)) return;
    setBusy(true);
    try {
      const r = (await fetch(
        `/api/speakers?name=${encodeURIComponent(s.name)}`,
        { method: "DELETE" },
      ).then((x) => x.json())) as { ok: boolean; speakers: SpeakerRecord[] };
      setSpeakers(r.speakers);
      setMsg(
        r.ok
          ? { ok: true, text: `「${s.name}」さんの声を忘れました` }
          : { ok: false, text: "削除に失敗しました" },
      );
    } catch {
      setMsg({ ok: false, text: "削除に失敗しました" });
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p className="settings-error">{error}</p>;
  if (!speakers) return <p className="settings-hint">読み込み中…</p>;

  return (
    <>
      <p className="settings-hint" style={{ marginBottom: 14 }}>
        声で個人識別する相手の一覧です．新規登録は会話で「私の声を覚えて，◯◯です」と
        谺へ話しかけてください（声のサンプルが必要なため画面からは追加できません）．
      </p>
      {speakers.length === 0 && (
        <p className="settings-hint">登録済みの話者はまだいません．</p>
      )}
      {speakers.map((s) => {
        const e = editOf(s);
        const dirty = e.name !== s.name || e.reading !== (s.reading ?? "");
        return (
          <section className="settings-row speaker-row" key={s.id}>
            <div className="settings-field">
              <span>名前</span>
              <input
                type="text"
                value={e.name}
                onChange={(ev) => setEdit(s, { name: ev.target.value })}
              />
            </div>
            <div className="settings-field">
              <span>読み</span>
              <input
                type="text"
                value={e.reading}
                onChange={(ev) => setEdit(s, { reading: ev.target.value })}
                placeholder="よみがな（任意）"
              />
            </div>
            <div className="settings-control">
              <span className="speaker-meta">
                声サンプル {s.sampleCount} 件・登録 {s.createdAt.slice(0, 10)}
              </span>
              <button onClick={() => void rename(s)} disabled={busy || !dirty}>
                保存
              </button>
              <button className="danger" onClick={() => void forget(s)} disabled={busy}>
                削除
              </button>
            </div>
          </section>
        );
      })}
      {msg && (
        <p className={`settings-result ${msg.ok ? "ok" : "ng"}`}>{msg.text}</p>
      )}
    </>
  );
}
