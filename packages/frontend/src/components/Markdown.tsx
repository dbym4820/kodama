import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 谺の応答を整形表示するマークダウンレンダラ（GFM: 表・打ち消し・自動リンク対応）.
 * リンクは常に新しいタブで開き, 外部サイトへそのまま飛べるようにする.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
