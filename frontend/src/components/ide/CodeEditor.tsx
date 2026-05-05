import Editor from "@monaco-editor/react";
import type { FileNode } from "@/lib/projects";

interface Props {
  file: FileNode | null;
  onChange: (content: string) => void;
}

export function CodeEditor({ file, onChange }: Props) {
  if (!file) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--editor-bg)] text-sm text-muted-foreground">
        Select a file to start editing
      </div>
    );
  }
  return (
    <div className="h-full bg-[var(--editor-bg)]">
      <Editor
        key={file.id}
        height="100%"
        theme="vs-dark"
        language={file.language}
        value={file.content}
        onChange={(v) => onChange(v ?? "")}
        options={{
          fontSize: 13,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontLigatures: true,
          tabSize: 2,
          automaticLayout: true,
          wordWrap: "on",
          smoothScrolling: true,
        }}
      />
    </div>
  );
}
