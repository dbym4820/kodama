import { useCallback, useEffect, useRef, useState } from "react";
import type { FileRecord } from "@kodama/shared";
import { formatSize } from "../format.js";

/**
 * ファイル画面（オーバーレイ）. ファイルをアップロードしてローカルDB
 * （SQLiteのBLOB）へ保管し, 一覧からダウンロード・削除できる.
 * バックエンドのREST（/api/files）越しに操作する.
 */
export function FilesPanel({ onClose }: { onClose: () => void }) {
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await fetch("/api/files");
      if (!r.ok) throw new Error();
      setFiles((await r.json()) as FileRecord[]);
      setError("");
    } catch {
      setError("ファイル一覧を取得できませんでした（バックエンド未接続）．");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const upload = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setUploading(true);
    setError("");
    try {
      for (const f of Array.from(list)) {
        const form = new FormData();
        form.append("file", f);
        const r = await fetch("/api/files", { method: "POST", body: form });
        if (!r.ok) throw new Error(f.name);
      }
      await reload();
    } catch (e) {
      const name = e instanceof Error && e.message ? `（${e.message}）` : "";
      setError(`アップロードに失敗しました${name}．`);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/files/${id}`, { method: "DELETE" }).catch(() => {});
    await reload();
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>ファイル</h2>
          <button className="settings-close" onClick={onClose} title="閉じる">
            ✕
          </button>
        </div>

        {error && <p className="settings-error">{error}</p>}

        <section className="settings-row">
          <label>アップロード</label>
          <div className="settings-control">
            <input
              ref={inputRef}
              type="file"
              multiple
              disabled={uploading}
              onChange={(e) => void upload(e.target.files)}
            />
          </div>
          <p className="settings-hint">
            {uploading
              ? "アップロード中…"
              : "選んだファイルはローカルDB（SQLite）にバイナリで保存されます（1件100MBまで）．"}
          </p>
        </section>

        <section className="settings-row">
          <label>保存済みファイル</label>
          {files.length === 0 && !error && (
            <p className="settings-hint">まだファイルはありません．</p>
          )}
          <ul className="file-list">
            {files.map((f) => (
              <li key={f.id} className="file-item">
                <a
                  className="file-name"
                  href={`/api/files/${f.id}`}
                  download={f.name}
                  title="ダウンロード"
                >
                  {f.name}
                </a>
                <span className="file-meta">
                  {formatSize(f.size)}・{new Date(f.createdAt).toLocaleString()}
                </span>
                <button
                  className="file-delete"
                  onClick={() => void remove(f.id)}
                  title="削除"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
