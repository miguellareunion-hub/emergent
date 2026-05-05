import { useState } from "react";
import { Plus, FileText, Trash2, Pencil, Check, X } from "lucide-react";
import type { FileNode } from "@/lib/projects";
import { cn } from "@/lib/utils";

interface Props {
  files: FileNode[];
  activeFileId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  projectName: string;
  onRenameProject: (name: string) => void;
}

export function FileExplorer({
  files,
  activeFileId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  projectName,
  onRenameProject,
}: Props) {
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [editingProject, setEditingProject] = useState(false);
  const [projectDraft, setProjectDraft] = useState(projectName);

  const submit = () => {
    const name = newName.trim();
    if (!name) return;
    onCreate(name);
    setNewName("");
    setCreating(false);
  };

  return (
    <div className="flex h-full flex-col bg-[var(--sidebar-bg)] text-foreground">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        {editingProject ? (
          <div className="flex flex-1 items-center gap-1">
            <input
              autoFocus
              value={projectDraft}
              onChange={(e) => setProjectDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onRenameProject(projectDraft.trim() || projectName);
                  setEditingProject(false);
                }
                if (e.key === "Escape") setEditingProject(false);
              }}
              className="w-full rounded bg-input px-2 py-1 text-sm outline-none ring-1 ring-border focus:ring-primary"
            />
            <button
              onClick={() => {
                onRenameProject(projectDraft.trim() || projectName);
                setEditingProject(false);
              }}
              className="rounded p-1 hover:bg-muted"
            >
              <Check className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <button
            onClick={() => {
              setProjectDraft(projectName);
              setEditingProject(true);
            }}
            className="flex flex-1 items-center gap-2 truncate text-left text-sm font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
            title="Rename project"
          >
            <span className="truncate">{projectName}</span>
            <Pencil className="h-3 w-3 opacity-60" />
          </button>
        )}
      </div>

      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Files
        </span>
        <button
          onClick={() => setCreating(true)}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="New file"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {creating && (
        <div className="flex items-center gap-1 px-3 pb-2">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="filename.ext"
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") {
                setCreating(false);
                setNewName("");
              }
            }}
            className="w-full rounded bg-input px-2 py-1 text-sm outline-none ring-1 ring-border focus:ring-primary"
          />
          <button onClick={submit} className="rounded p-1 hover:bg-muted">
            <Check className="h-4 w-4" />
          </button>
          <button
            onClick={() => {
              setCreating(false);
              setNewName("");
            }}
            className="rounded p-1 hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="flex-1 overflow-auto px-1 pb-3">
        {files.map((f) => {
          const active = f.id === activeFileId;
          const renaming = renamingId === f.id;
          return (
            <div
              key={f.id}
              className={cn(
                "group flex items-center gap-2 rounded px-2 py-1.5 text-sm",
                active ? "bg-accent text-accent-foreground" : "hover:bg-muted",
              )}
            >
              <FileText className="h-4 w-4 shrink-0 opacity-70" />
              {renaming ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      onRename(f.id, renameValue.trim() || f.name);
                      setRenamingId(null);
                    }
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  className="flex-1 rounded bg-input px-1 py-0.5 text-sm outline-none ring-1 ring-primary"
                />
              ) : (
                <button
                  onClick={() => onSelect(f.id)}
                  onDoubleClick={() => {
                    setRenamingId(f.id);
                    setRenameValue(f.name);
                  }}
                  className="flex-1 truncate text-left"
                >
                  {f.name}
                </button>
              )}
              <button
                onClick={() => {
                  setRenamingId(f.id);
                  setRenameValue(f.name);
                }}
                className="rounded p-1 opacity-0 transition group-hover:opacity-100 hover:bg-background/40"
                title="Rename"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                onClick={() => {
                  if (confirm(`Delete ${f.name}?`)) onDelete(f.id);
                }}
                className="rounded p-1 text-destructive opacity-0 transition group-hover:opacity-100 hover:bg-background/40"
                title="Delete"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          );
        })}
        {files.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No files yet. Click + to create one.
          </p>
        )}
      </div>
    </div>
  );
}
