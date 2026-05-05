import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, ExternalLink } from "lucide-react";
import { buildPreviewDoc, type FileNode } from "@/lib/projects";
import { pushRuntimeError } from "@/lib/runtimeErrors";

interface Props {
  files: FileNode[];
  onConsole: (entry: { level: string; msg: string; ts: number }) => void;
}

export function PreviewPane({ files, onConsole }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [nonce, setNonce] = useState(0);

  const doc = useMemo(() => buildPreviewDoc(files), [files]);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const data = e.data;
      if (data && data.__ide_console) {
        const entry = { level: data.level, msg: data.msg, ts: Date.now() };
        onConsole(entry);
        if (entry.level === "error") {
          pushRuntimeError(entry);
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onConsole]);

  return (
    <div className="flex h-full flex-col bg-[var(--panel-bg)]">
      <div className="flex items-center justify-between border-b border-border bg-[var(--sidebar-bg)] px-3 py-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Live Preview
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setNonce((n) => n + 1)}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Reload"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            onClick={() => {
              const w = window.open();
              if (w) {
                w.document.open();
                w.document.write(doc);
                w.document.close();
              }
            }}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Open in new tab"
          >
            <ExternalLink className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 bg-white">
        <iframe
          ref={iframeRef}
          key={nonce}
          title="preview"
          sandbox="allow-scripts allow-modals allow-forms"
          srcDoc={doc}
          className="h-full w-full border-0"
        />
      </div>
    </div>
  );
}
