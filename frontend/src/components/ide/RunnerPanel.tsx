import { useEffect, useRef, useState, useCallback } from "react";
import { Play, Square, Loader2, ExternalLink, Settings as SettingsIcon, Trash2, Server, Wrench, RefreshCw, Sparkles } from "lucide-react";
import type { FileNode } from "@/lib/projects";
import { loadRunnerSettings, saveRunnerSettings, type RunnerSettings } from "@/lib/runnerSettings";
import { pushRuntimeError } from "@/lib/runtimeErrors";

interface Props {
  projectId: string;
  files: FileNode[];
}

type LogEntry = { level: string; line: string; ts: number };
type Status = "idle" | "starting" | "installing" | "running" | "stopped" | "error";

/** Heuristic: is this stderr line a real error (vs a warning, info, color code)? */
function isLikelyError(line: string): boolean {
  const lower = line.toLowerCase();
  if (/^npm warn/i.test(line)) return false;
  if (/^npm notice/i.test(line)) return false;
  return (
    /error[:\s]/i.test(lower) ||
    /\b(syntaxerror|typeerror|referenceerror|rangeerror)\b/i.test(lower) ||
    /\bcannot find module\b/i.test(lower) ||
    /\bdoes not provide an export\b/i.test(lower) ||
    /\beaddrinuse\b/i.test(lower) ||
    /\berr_module_not_found\b/i.test(lower) ||
    /^\s*at\s+\S+/i.test(line) // stack frame
  );
}

/** Send an error line to the AgentChat to ask the Fixer to repair it. */
function sendToFixer(errorLine: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("lovable:fix-runner-error", { detail: { error: errorLine } }),
  );
}

export function RunnerPanel({ projectId, files }: Props) {
  const [settings, setSettings] = useState<RunnerSettings>(() => loadRunnerSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [healthMsg, setHealthMsg] = useState<string | null>(null);
  const [agentActivity, setAgentActivity] = useState<string | null>(null);
  const [autoSync, setAutoSync] = useState(true);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const filesRef = useRef(files);
  filesRef.current = files;

  const baseUrl = settings.url.replace(/\/+$/, "");
  const previewUrl = `${baseUrl}/preview/${encodeURIComponent(projectId)}/`;
  const wsUrl = baseUrl.replace(/^http/, "ws") + `/ws?token=${encodeURIComponent(settings.token)}&projectId=${encodeURIComponent(projectId)}`;

  /** True if this project actually has a Node entry — without one, the Node
   * Runner has nothing to run (the iframe Preview tab handles browser-only
   * projects). */
  const hasPackageJson = files.some(
    (f) => f.name === "package.json" || f.name.endsWith("/package.json"),
  );

  // connect WS
  useEffect(() => {
    if (!settings.token || !settings.url) return;
    let closed = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      return;
    }
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === "log") {
          const entry = { level: m.level, line: m.line, ts: m.ts };
          setLogs((p) => [...p.slice(-1999), entry]);
          // Forward stderr / process exit lines to the global runtime error bus
          // so the Fixer agent picks them up automatically.
          if (m.level === "stderr" && typeof m.line === "string") {
            const trimmed = m.line.trim();
            if (trimmed && isLikelyError(trimmed)) {
              pushRuntimeError({ level: "stderr", msg: trimmed, ts: m.ts || Date.now() });
            }
          }
        }
        if (m.type === "status") setStatus(m.status as Status);
      } catch (_) {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (!closed) wsRef.current = null;
    };
    return () => {
      closed = true;
      try { ws.close(); } catch (_) { /* */ }
    };
  }, [wsUrl, settings.token, settings.url]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs.length]);

  // Auto-run when the agent finishes a cycle (if URL + token are configured).
  useEffect(() => {
    const onAgentDone = () => {
      setAgentActivity(null);
      if (!settings.token || !settings.url) return;
      // Fire and forget — handleRun reads the latest files via closure.
      void handleRun();
    };
    const onAgentStart = (ev: Event) => {
      const detail = (ev as CustomEvent<{ label?: string }>).detail;
      setAgentActivity(detail?.label ?? "Agent en cours…");
    };
    const onAgentStatus = (ev: Event) => {
      const detail = (ev as CustomEvent<{ label?: string }>).detail;
      if (detail?.label) setAgentActivity(detail.label);
    };
    const onAgentFileWrite = (ev: Event) => {
      const detail = (ev as CustomEvent<{ path?: string }>).detail;
      if (detail?.path) {
        setLogs((p) => [
          ...p.slice(-1999),
          { level: "system", line: `✎ Agent a écrit ${detail.path}`, ts: Date.now() },
        ]);
      }
    };
    window.addEventListener("lovable:agent-done", onAgentDone);
    window.addEventListener("lovable:agent-start", onAgentStart);
    window.addEventListener("lovable:agent-status", onAgentStatus);
    window.addEventListener("lovable:agent-file-write", onAgentFileWrite);
    return () => {
      window.removeEventListener("lovable:agent-done", onAgentDone);
      window.removeEventListener("lovable:agent-start", onAgentStart);
      window.removeEventListener("lovable:agent-status", onAgentStatus);
      window.removeEventListener("lovable:agent-file-write", onAgentFileWrite);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.token, settings.url, projectId, settings.script]);

  const checkHealth = useCallback(async () => {
    setHealthMsg("…");
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      const j = await r.json();
      setHealthMsg(j.ok ? (j.hasToken ? "✓ Runner OK (token configuré)" : "⚠ Runner sans token — refusera les requêtes") : "Erreur");
    } catch (e) {
      setHealthMsg(`✗ Inaccessible: ${(e as Error).message}`);
    }
  }, [baseUrl]);

  const handleRun = useCallback(async () => {
    if (!settings.token) {
      setShowSettings(true);
      setHealthMsg("Définis l'URL et le token d'abord.");
      return;
    }
    setBusy(true);
    setLogs([]);
    setStatus("starting");
    try {
      const payload = {
        projectId,
        script: settings.script || "dev",
        files: filesRef.current.map((f) => ({ path: f.name, content: f.content })),
      };
      const r = await fetch(`${baseUrl}/api/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.token}`,
        },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const t = await r.text();
        setLogs((p) => [...p, { level: "stderr", line: `HTTP ${r.status}: ${t}`, ts: Date.now() }]);
        setStatus("error");
      } else {
        setPreviewKey((k) => k + 1);
      }
    } catch (e) {
      setLogs((p) => [...p, { level: "stderr", line: `Connexion échouée: ${(e as Error).message}`, ts: Date.now() }]);
      setStatus("error");
    } finally {
      setBusy(false);
    }
  }, [baseUrl, projectId, settings.script, settings.token]);

  const handleStop = useCallback(async () => {
    setBusy(true);
    try {
      await fetch(`${baseUrl}/api/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.token}` },
        body: JSON.stringify({ projectId }),
      });
    } catch (e) {
      setLogs((p) => [...p, { level: "stderr", line: `Stop échoué: ${(e as Error).message}`, ts: Date.now() }]);
    } finally {
      setBusy(false);
    }
  }, [baseUrl, projectId, settings.token]);

  const handleRefreshPreview = useCallback(() => {
    setPreviewKey((k) => k + 1);
  }, []);

  // Hot-sync: re-send files to the runner whenever they change.
  // Debounced so rapid agent edits coalesce. Uses /api/sync which writes
  // files WITHOUT restarting the process (dev servers hot-reload naturally).
  // Falls back to /api/run only if /api/sync returns 404 (older runner).
  useEffect(() => {
    if (!autoSync) return;
    if (!settings.token || !settings.url) return;
    // Allow sync as soon as we know there's an active or starting project.
    // "idle" / "stopped" / "error" => skip.
    if (status === "idle" || status === "stopped" || status === "error") return;
    const t = window.setTimeout(async () => {
      try {
        const payload = {
          projectId,
          files: filesRef.current.map((f) => ({ path: f.name, content: f.content })),
        };
        const r = await fetch(`${baseUrl}/api/sync`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${settings.token}`,
          },
          body: JSON.stringify(payload),
        });
        if (r.status === 404) {
          // Older runner without /api/sync — fall back to a full /api/run
          await fetch(`${baseUrl}/api/run`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${settings.token}`,
            },
            body: JSON.stringify({ ...payload, script: settings.script || "dev" }),
          });
          setPreviewKey((k) => k + 1);
        } else if (r.ok) {
          // Light reload of the iframe so the user sees fresh HTML/CSS.
          setPreviewKey((k) => k + 1);
        }
        setLastSyncedAt(Date.now());
      } catch {
        /* ignore — logs already capture errors */
      }
    }, 600);
    return () => window.clearTimeout(t);
  }, [files, autoSync, status, baseUrl, projectId, settings.script, settings.token, settings.url]);

  const isRunning = status === "running" || status === "installing" || status === "starting";

  return (
    <div className="flex h-full flex-col bg-[var(--panel-bg)]">
      <div className="flex items-center justify-between border-b border-border bg-[var(--sidebar-bg)] px-3 py-1.5">
        <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Server className="h-3.5 w-3.5" /> Node Runner
          <span className={
            "ml-2 rounded px-1.5 py-0.5 text-[10px] " +
            (status === "running" ? "bg-emerald-500/20 text-emerald-300" :
             status === "installing" || status === "starting" ? "bg-amber-500/20 text-amber-300" :
             status === "error" ? "bg-red-500/20 text-red-300" :
             "bg-muted text-muted-foreground")
          }>{status}</span>
        </span>
        <div className="flex items-center gap-1">
          {isRunning ? (
            <button
              onClick={handleStop}
              disabled={busy}
              className="flex items-center gap-1 rounded bg-red-500/80 px-2 py-1 text-xs text-white hover:bg-red-500 disabled:opacity-50"
            >
              <Square className="h-3 w-3" /> Stop
            </button>
          ) : (
            <button
              onClick={handleRun}
              disabled={busy || !hasPackageJson}
              title={hasPackageJson ? "Démarrer le runner" : "Ajoute un package.json pour utiliser le Node Runner"}
              className="flex items-center gap-1 rounded bg-emerald-600 px-2 py-1 text-xs text-white hover:bg-emerald-500 disabled:opacity-50"
              data-testid="runner-run-button"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              Run
            </button>
          )}
          <button
            onClick={handleRefreshPreview}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Recharger la preview"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <a
            href={previewUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Ouvrir la preview"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
          <button
            onClick={() => setLogs([])}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Vider les logs"
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Réglages runner"
          >
            <SettingsIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Live agent activity bar — visible while the agent is generating/fixing code */}
      {agentActivity && (
        <div className="flex items-center gap-2 border-b border-primary/30 bg-primary/10 px-3 py-1.5 text-xs text-primary">
          <Sparkles className="h-3.5 w-3.5 animate-pulse" />
          <span className="flex-1 truncate">{agentActivity}</span>
          <span className="text-[10px] text-primary/70">l'agent écrit le code…</span>
        </div>
      )}

      {/* Auto-sync toggle bar */}
      <div className="flex items-center gap-3 border-b border-border bg-[var(--sidebar-bg)] px-3 py-1 text-[11px] text-muted-foreground">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={autoSync}
            onChange={(e) => setAutoSync(e.target.checked)}
            className="h-3 w-3"
          />
          Auto-sync fichiers vers le runner
        </label>
        {lastSyncedAt && (
          <span className="text-[10px] opacity-70">
            Dernière sync : {new Date(lastSyncedAt).toLocaleTimeString([], { hour12: false })}
          </span>
        )}
      </div>

      {showSettings && (
        <div className="border-b border-border bg-[var(--sidebar-bg)] p-3 text-xs space-y-2">
          <div>
            <label className="mb-1 block text-muted-foreground">Runner URL</label>
            <input
              value={settings.url}
              onChange={(e) => setSettings({ ...settings, url: e.target.value })}
              placeholder="http://localhost:7070"
              className="w-full rounded border border-border bg-background px-2 py-1"
            />
          </div>
          <div>
            <label className="mb-1 block text-muted-foreground">Runner Token</label>
            <input
              type="password"
              value={settings.token}
              onChange={(e) => setSettings({ ...settings, token: e.target.value })}
              placeholder="même valeur que RUNNER_TOKEN côté serveur"
              className="w-full rounded border border-border bg-background px-2 py-1"
            />
          </div>
          <div>
            <label className="mb-1 block text-muted-foreground">npm script (ou "install")</label>
            <input
              value={settings.script}
              onChange={(e) => setSettings({ ...settings, script: e.target.value })}
              placeholder="dev"
              className="w-full rounded border border-border bg-background px-2 py-1"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { saveRunnerSettings(settings); setHealthMsg("Enregistré."); }}
              className="rounded bg-primary px-2 py-1 text-primary-foreground"
            >
              Enregistrer
            </button>
            <button onClick={checkHealth} className="rounded border border-border px-2 py-1">
              Tester
            </button>
            {healthMsg && <span className="text-muted-foreground">{healthMsg}</span>}
          </div>
          <p className="text-muted-foreground">
            Lance le serveur en local : <code>cd runner-server && npm install && RUNNER_TOKEN=monsecret npm start</code>
          </p>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex w-1/2 flex-col border-r border-border">
          <div ref={logRef} className="flex-1 overflow-auto bg-[var(--terminal-bg)] px-3 py-2 font-mono text-xs leading-relaxed">
            {logs.length === 0 ? (
              <p className="text-muted-foreground">
                Logs du serveur Node apparaîtront ici. Configure URL + token, puis clique <strong>Run</strong>.
              </p>
            ) : (
              logs.map((l, i) => {
                const fixable = l.level === "stderr" && isLikelyError(l.line);
                return (
                  <div key={i} className={
                    "group flex items-start gap-1 " + (
                      l.level === "stderr" ? "text-red-400" :
                      l.level === "system" ? "text-emerald-300" :
                      "text-foreground/90"
                    )
                  }>
                    <span className="opacity-50 shrink-0">[{new Date(l.ts).toLocaleTimeString([], { hour12: false })}]</span>
                    <span className="whitespace-pre-wrap flex-1">{l.line}</span>
                    {fixable && (
                      <button
                        onClick={() => sendToFixer(l.line)}
                        title="Demander au Fixer agent de corriger cette erreur"
                        className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-300 opacity-0 transition group-hover:opacity-100 hover:bg-amber-500/40"
                      >
                        <Wrench className="inline h-2.5 w-2.5" /> Fix
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
        <div className="flex w-1/2 flex-col">
          <div className="border-b border-border bg-[var(--sidebar-bg)] px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            App preview ({previewUrl})
          </div>
          {hasPackageJson ? (
            <iframe
              key={previewKey}
              src={previewUrl}
              title="runner-preview"
              className="flex-1 bg-white"
            />
          ) : (
            <div
              className="flex flex-1 items-center justify-center bg-[var(--panel-bg)] p-8"
              data-testid="runner-no-package-json-banner"
            >
              <div className="max-w-sm space-y-3 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-400">
                  <Server className="h-5 w-5" />
                </div>
                <h3 className="text-sm font-semibold text-foreground">
                  Projet browser-only
                </h3>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Ce projet n'a pas de <code className="rounded bg-muted px-1 py-0.5">package.json</code> —
                  le Node Runner n'a rien à exécuter. Utilise plutôt l'onglet
                  {" "}
                  <strong className="text-foreground">Preview</strong> en haut, qui rend
                  les fichiers HTML/CSS/JS dans une iframe légère.
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Demande à l'agent IA de créer un <code>package.json</code> + un
                  serveur Node si tu veux un vrai backend.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
