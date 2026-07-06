import { useRef, useState } from "react";
import type { ClientCommand, FileRecord } from "@kodama/shared";
import type { UploadRequest } from "../useKodamaSocket.js";

/**
 * 谺がファイルを必要としたとき（request_file_upload ツール）に一時表示する
 * ドロップゾーン. ドラッグ&ドロップまたはクリック選択で受け取り,
 * /api/files へアップロード（DBにBLOB格納）して結果を files_uploaded で谺へ返す.
 */
export function UploadDropzone({
  req,
  send,
  onClose,
}: {
  req: UploadRequest;
  send: (cmd: ClientCommand) => void;
  onClose: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const upload = async (list: FileList | File[] | null) => {
    const files = list ? Array.from(list) : [];
    if (files.length === 0 || uploading) return;
    const targets = req.multiple === false ? files.slice(0, 1) : files;
    setUploading(true);
    setError("");
    try {
      const saved: FileRecord[] = [];
      for (const f of targets) {
        const form = new FormData();
        form.append("file", f);
        const r = await fetch("/api/files", { method: "POST", body: form });
        if (!r.ok) throw new Error(f.name);
        saved.push((await r.json()) as FileRecord);
      }
      send({ type: "files_uploaded", requestId: req.id, files: saved });
      onClose();
    } catch (e) {
      const name = e instanceof Error && e.message ? `（${e.message}）` : "";
      setError(`アップロードに失敗しました${name}．もう一度お試しください．`);
      setUploading(false);
    }
  };

  const cancel = () => {
    send({
      type: "files_uploaded",
      requestId: req.id,
      files: [],
      canceled: true,
    });
    onClose();
  };

  return (
    <div
      className={`upload-zone ${dragging ? "dragging" : ""} ${uploading ? "busy" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void upload(e.dataTransfer.files);
      }}
      onClick={() => !uploading && inputRef.current?.click()}
      role="button"
      title="クリックしてファイルを選ぶこともできます"
    >
      <button
        type="button"
        className="upload-close"
        onClick={(e) => {
          e.stopPropagation();
          cancel();
        }}
        title="アップロードせずに閉じる"
      >
        ✕
      </button>
      <div className="upload-icon">📄</div>
      <p className="upload-title">
        {req.title ?? "ファイルをここにドロップしてください"}
      </p>
      <p className="upload-sub">
        {uploading
          ? "アップロード中…"
          : `ドラッグ&ドロップ / クリックで選択${req.multiple === false ? "（1件）" : "（複数可）"}`}
      </p>
      {error && <p className="upload-error">{error}</p>}
      <input
        ref={inputRef}
        type="file"
        hidden
        accept={req.accept}
        multiple={req.multiple !== false}
        onChange={(e) => void upload(e.target.files)}
      />
    </div>
  );
}
