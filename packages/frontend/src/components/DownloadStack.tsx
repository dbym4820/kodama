import type { DownloadOffer } from "../useKodamaSocket.js";
import { formatSize } from "../format.js";

/**
 * ダウンロードカード（谺の save_file / offer_file_download で表示）.
 * ステージ右上に積み上げ, ファイル名クリックで /api/files/:id からダウンロードする.
 */
export function DownloadStack({
  offers,
  onClose,
}: {
  offers: DownloadOffer[];
  onClose: (id: string) => void;
}) {
  if (offers.length === 0) return null;
  return (
    <div className="download-stack">
      {offers.map((o) => (
        <div key={o.id} className="download-card">
          <div className="download-head">
            <span className="download-title">
              ⬇ {o.title ?? "ファイルをダウンロードできます"}
            </span>
            <button
              className="download-close"
              onClick={() => onClose(o.id)}
              title="閉じる"
            >
              ✕
            </button>
          </div>
          {o.files.map((f) => (
            <a
              key={f.id}
              className="download-file"
              href={`/api/files/${f.id}`}
              download={f.name}
              title="クリックでダウンロード"
            >
              <span className="download-name">{f.name}</span>
              <span className="download-size">{formatSize(f.size)}</span>
            </a>
          ))}
        </div>
      ))}
    </div>
  );
}
