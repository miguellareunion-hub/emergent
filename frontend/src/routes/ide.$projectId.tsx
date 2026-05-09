import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import {
  ArrowLeft,
  Code2,
  MessageSquare,
  TerminalSquare,
  Eye,
  Settings as SettingsIcon,
  Bot,
  Download,
  Server,
  Bug,
} from "lucide-react";
import JSZip from "jszip";
import { useProject } from "@/hooks/useProject";
import { FileExplorer } from "@/components/ide/FileExplorer";
import { CodeEditor } from "@/components/ide/CodeEditor";
import { PreviewPane } from "@/components/ide/PreviewPane";
import { Terminal, type ConsoleEntry } from "@/components/ide/Terminal";
import { AgentChat } from "@/components/ide/AgentChat";
import { RunnerPanel } from "@/components/ide/RunnerPanel";
import { QAPanel } from "@/components/ide/QAPanel";
import { SettingsDialog } from "@/components/ide/SettingsDialog";
import { AgentsDialog } from "@/components/ide/AgentsDialog";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/ide/$projectId")({
  head: () => ({
    meta: [
      { title: "Editor — Lovable IDE" },
      { name: "description", content: "Edit your project in Lovable IDE." },
    ],
  }),
  component: IdePage,
});

type RightTab = "preview" | "agent" | "runner" | "qa";
type BottomTab = "terminal";

function IdePage() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  const {
    project,
    loaded,
    activeFileId,
    setActiveFileId,
    updateFile,
    createFile,
    deleteFile,
    renameFile,
    renameProject,
    writeFileByPath,
    renameFileByPath,
    deleteFileByPath,
    getLatestFiles,
  } = useProject(projectId);

  const [rightTab, setRightTab] = useState<RightTab>("preview");
  const [bottomOpen, setBottomOpen] = useState(true);
  const [console_, setConsole] = useState<ConsoleEntry[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);

  const pushConsole = useCallback((e: ConsoleEntry) => {
    setConsole((prev) => [...prev.slice(-499), e]);
  }, []);

  const handleCommand = useCallback(
    (cmd: string) => {
      const ts = Date.now();
      setConsole((prev) => [...prev, { level: "input", msg: `$ ${cmd}`, ts }]);
      const [name, ...rest] = cmd.split(" ");
      const arg = rest.join(" ");
      let response = "";
      switch (name) {
        case "help":
          response =
            "Available: help, ls, cat <file>, echo <text>, clear, open <file>, run, date";
          break;
        case "ls":
          response = project ? project.files.map((f) => f.name).join("  ") : "(no project)";
          break;
        case "cat": {
          const f = project?.files.find((x) => x.name === arg);
          response = f ? f.content || "(empty)" : `cat: ${arg}: No such file`;
          break;
        }
        case "open": {
          const f = project?.files.find((x) => x.name === arg);
          if (f) {
            setActiveFileId(f.id);
            response = `Opened ${f.name}`;
          } else response = `open: ${arg}: No such file`;
          break;
        }
        case "echo":
          response = arg;
          break;
        case "clear":
          setConsole([]);
          return "";
        case "run":
          response = "Preview auto-runs on every change.";
          break;
        case "date":
          response = new Date().toString();
          break;
        case "":
          return "";
        default:
          response = `command not found: ${name}. Try 'help'.`;
      }
      setConsole((prev) => [...prev, { level: "system", msg: response, ts: Date.now() }]);
      return response;
    },
    [project, setActiveFileId],
  );

  const handleDownloadZip = useCallback(async () => {
    if (!project) return;
    const zip = new JSZip();
    for (const f of project.files) {
      zip.file(f.name, f.content ?? "");
    }
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${project.name || "project"}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [project]);

  if (!loaded) {
    return (
      <div className="flex min-h-screen items-center justify-center text-foreground">
        <p className="text-muted-foreground">Loading project…</p>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex min-h-screen items-center justify-center text-foreground">
        <div className="text-center">
          <h1 className="text-2xl font-semibold">Project not found</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This project doesn't exist on this device. Projects are stored locally in your browser.
          </p>
          <Link to="/" className="mt-4 inline-block text-primary hover:underline">
            ← Back to projects
          </Link>
        </div>
      </div>
    );
  }

  const activeFile = project.files.find((f) => f.id === activeFileId) ?? null;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-12 items-center justify-between border-b border-border/70 bg-[var(--sidebar-bg)] px-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate({ to: "/" })}
            className="flex items-center gap-1.5 rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
            title="Retour aux projets"
            data-testid="back-to-projects-btn"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm shadow-primary/25">
              <Code2 className="h-3.5 w-3.5" />
            </div>
            <div className="hidden flex-col leading-tight sm:flex">
              <span className="text-[13px] font-semibold tracking-tight">Lovable IDE</span>
              <span className="text-[10px] text-muted-foreground/70">in-browser dev</span>
            </div>
          </div>
          <div className="ml-2 hidden h-5 w-px bg-border sm:block" />
          <span className="truncate text-sm font-medium text-foreground/90" data-testid="current-project-name">
            {project.name}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <TabButton
            active={rightTab === "preview"}
            onClick={() => setRightTab("preview")}
            icon={<Eye className="h-3.5 w-3.5" />}
            label="Preview"
          />
          <TabButton
            active={rightTab === "agent"}
            onClick={() => setRightTab("agent")}
            icon={<MessageSquare className="h-3.5 w-3.5" />}
            label="Agent"
          />
          <TabButton
            active={rightTab === "runner"}
            onClick={() => setRightTab("runner")}
            icon={<Server className="h-3.5 w-3.5" />}
            label="Runner"
          />
          <TabButton
            active={rightTab === "qa"}
            onClick={() => setRightTab("qa")}
            icon={<Bug className="h-3.5 w-3.5" />}
            label="QA"
          />
          <TabButton
            active={bottomOpen}
            onClick={() => setBottomOpen((v) => !v)}
            icon={<TerminalSquare className="h-3.5 w-3.5" />}
            label="Terminal"
          />
          <button
            onClick={() => setAgentsOpen(true)}
            title="Configurer les agents"
            className="ml-1 flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Bot className="h-3.5 w-3.5" />
            Agents
          </button>
          <button
            onClick={handleDownloadZip}
            title="Télécharger le projet en .zip"
            className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Download className="h-3.5 w-3.5" />
            ZIP
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            title="AI settings"
            className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <SettingsIcon className="h-3.5 w-3.5" />
            Settings
          </button>
        </div>
      </header>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <AgentsDialog open={agentsOpen} onClose={() => setAgentsOpen(false)} />

      <div className="flex min-h-0 flex-1">
        {/* File explorer */}
        <aside className="w-60 shrink-0 border-r border-border">
          <FileExplorer
            files={project.files}
            activeFileId={activeFileId}
            onSelect={setActiveFileId}
            onCreate={createFile}
            onDelete={deleteFile}
            onRename={renameFile}
            projectName={project.name}
            onRenameProject={renameProject}
          />
        </aside>

        {/* Main editor + bottom terminal */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 items-center gap-1 border-b border-border bg-[var(--sidebar-bg)] px-2">
            {activeFile && (
              <div className="flex items-center gap-2 rounded-t-md border border-b-0 border-border bg-[var(--editor-bg)] px-3 py-1.5 text-xs">
                <span>{activeFile.name}</span>
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1">
            <CodeEditor
              file={activeFile}
              onChange={(content) => activeFile && updateFile(activeFile.id, content)}
            />
          </div>
          {bottomOpen && (
            <div className="h-56 border-t border-border">
              <Terminal
                entries={console_}
                onClear={() => setConsole([])}
                onCommand={handleCommand}
              />
            </div>
          )}
        </div>

        {/* Right pane: preview or agent */}
        <aside className="w-[42%] min-w-[320px] shrink-0 border-l border-border">
          <div className={cn("h-full", rightTab === "preview" ? "block" : "hidden")}>
            <PreviewPane files={project.files} onConsole={pushConsole} />
          </div>
          <div className={cn("h-full", rightTab === "agent" ? "block" : "hidden")}>
            <AgentChat
              projectId={project.id}
              files={project.files}
              activeFile={activeFile}
              onOpenSettings={() => setSettingsOpen(true)}
              onWriteFile={writeFileByPath}
              onRenameFile={renameFileByPath}
              onDeleteFile={deleteFileByPath}
              onSwitchToPreview={() => setRightTab("preview")}
              getLatestFiles={getLatestFiles}
            />
          </div>
          <div className={cn("h-full", rightTab === "runner" ? "block" : "hidden")}>
            <RunnerPanel projectId={project.id} files={project.files} />
          </div>
          <div className={cn("h-full", rightTab === "qa" ? "block" : "hidden")}>
            <QAPanel
              projectId={project.id}
              files={project.files}
              onSendToBuilder={(msg) => {
                // Bridge: hand the QA report to the AgentChat, switch tabs.
                window.dispatchEvent(
                  new CustomEvent("lovable:qa-report-to-builder", {
                    detail: { message: msg },
                  }),
                );
                setRightTab("agent");
              }}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
