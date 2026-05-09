import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bug,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  RefreshCw,
  Send,
  ChevronDown,
  ChevronRight,
  Image as ImageIcon,
  Smartphone,
  Monitor,
} from "lucide-react";
import { buildPreviewDoc, type FileNode } from "@/lib/projects";
import { loadRunnerSettings } from "@/lib/runnerSettings";

interface Props {
  projectId: string;
  files: FileNode[];
  /** Provided by the IDE so QA can ask the Builder agent to fix issues. */
  onSendToBuilder?: (message: string) => void;
}

type QAStatus = "ok" | "warn" | "fail";

interface QAReport {
  status: QAStatus;
  summary: string;
  navigation: {
    finalUrl: string;
    httpStatus: number | null;
    loadTimeMs: number;
    blank: boolean;
    title: string;
  };
  console: Array<{ level: string; text: string }>;
  pageErrors: Array<{ message: string; stack?: string }>;
  failedRequests: Array<{ url: string; method: string; status: number | null; reason: string }>;
  ui: {
    hasContent: boolean;
    bodyTextLength: number;
    elementCounts: Record<string, number>;
    missingExpected: string[];
    visibleButtons: number;
    visibleInputs: number;
    images: { total: number; broken: number };
  };
  responsive: {
    desktopOverflow: boolean;
    mobileOverflow: boolean;
    horizontalScrollAt375: boolean;
  };
  screenshots: { desktop?: string; mobile?: string };
  recommendations: string[];
  durationMs: number;
}

const STATUS_META: Record<QAStatus, { color: string; icon: React.ElementType; label: string }> = {
  ok: { color: "text-emerald-500", icon: CheckCircle2, label: "Project validated successfully" },
  warn: { color: "text-amber-500", icon: AlertTriangle, label: "Issues detected" },
  fail: { color: "text-red-500", icon: XCircle, label: "Project failed validation" },
};

export function QAPanel({ projectId, files, onSendToBuilder }: Props) {
  const [report, setReport] = useState<QAReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoMode, setAutoMode] = useState(false);
  const [showShots, setShowShots] = useState(true);
  const [activeTab, setActiveTab] = useState<"desktop" | "mobile">("desktop");
  const lastFingerprintRef = useRef<string>("");

  // Compute a fingerprint of the project so we can detect "files changed"
  // and trigger an auto-retest in auto mode.
  const fingerprint = useMemo(
    () => files.map((f) => `${f.name}:${f.content.length}`).join("|"),
    [files],
  );

  const runQA = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const settings = loadRunnerSettings();
      const html = buildPreviewDoc(files);
      const r = await fetch("/api/qa", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.token}`,
        },
        body: JSON.stringify({
          html,
          testMobile: true,
          timeoutMs: 9000,
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setReport(data as QAReport);
      lastFingerprintRef.current = fingerprint;
    } catch (e) {
      setError(e instanceof Error ? e.message : "QA request failed");
    } finally {
      setBusy(false);
    }
  };

  // Auto retest when files change AND auto mode is on AND we have at least
  // one previous report (otherwise the very first project would loop test).
  useEffect(() => {
    if (!autoMode || busy || !report) return;
    if (fingerprint === lastFingerprintRef.current) return;
    const t = setTimeout(() => runQA(), 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint, autoMode]);

  const sendBugReportToBuilder = () => {
    if (!report || !onSendToBuilder) return;
    const lines: string[] = [];
    lines.push(`🤖 QA_AGENT a testé l'application et a trouvé ${report.recommendations.length} problème(s) :`);
    lines.push("");
    if (report.pageErrors.length > 0) {
      lines.push("**Erreurs JavaScript runtime :**");
      report.pageErrors.slice(0, 5).forEach((e, i) => {
        lines.push(`${i + 1}. ${e.message}${e.stack ? `\n   ${e.stack.split("\n")[0]}` : ""}`);
      });
      lines.push("");
    }
    if (report.failedRequests.length > 0) {
      lines.push("**Requêtes échouées :**");
      report.failedRequests.slice(0, 5).forEach((r, i) => {
        lines.push(`${i + 1}. ${r.method} ${r.url} → ${r.status ?? "?"} (${r.reason})`);
      });
      lines.push("");
    }
    if (report.navigation.blank) {
      lines.push("**Page blanche détectée** — le DOM ne contient pas de contenu visible.");
      lines.push("");
    }
    if (report.responsive.mobileOverflow) {
      lines.push("**Layout responsive cassé** — débordement horizontal à 375px de large.");
      lines.push("");
    }
    if (report.ui.images.broken > 0) {
      lines.push(`**${report.ui.images.broken} image(s) cassée(s)** — vérifie les chemins src=.`);
      lines.push("");
    }
    if (report.ui.missingExpected.length > 0) {
      lines.push(`**Éléments UI manquants :** ${report.ui.missingExpected.join(", ")}`);
      lines.push("");
    }
    lines.push("**Actions recommandées :**");
    report.recommendations.forEach((r) => lines.push(`- ${r}`));
    lines.push("");
    lines.push("Corrige UNIQUEMENT ces problèmes, sans réécrire les fichiers qui marchent. Ne supprime aucun fichier.");
    onSendToBuilder(lines.join("\n"));
  };

  const StatusIcon = report ? STATUS_META[report.status].icon : Bug;

  return (
    <div className="flex h-full flex-col bg-[var(--panel-bg)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-[var(--sidebar-bg)] px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded bg-emerald-500/15 text-emerald-500">
            <Bug className="h-3.5 w-3.5" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-[12px] font-semibold tracking-tight">QA_AGENT</span>
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground/70">
              autonomous browser tester
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <label
            className="inline-flex cursor-pointer items-center gap-1.5 rounded border border-border bg-card px-2 py-1 text-[10px] hover:border-primary/60"
            title="Re-test automatically when files change"
          >
            <input
              type="checkbox"
              checked={autoMode}
              onChange={(e) => setAutoMode(e.target.checked)}
              className="h-3 w-3 cursor-pointer accent-primary"
              data-testid="qa-auto-toggle"
            />
            Auto
          </label>
          <button
            onClick={runQA}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
            data-testid="qa-run-btn"
          >
            {busy ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" /> Testing…
              </>
            ) : (
              <>
                <RefreshCw className="h-3 w-3" /> Run QA
              </>
            )}
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-3 py-3">
        {!report && !busy && !error && (
          <div className="rounded-lg border border-dashed border-border bg-card/30 p-6 text-center">
            <Bug className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-foreground">Aucun rapport encore.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Lance le QA_AGENT pour tester ton projet — il ouvre un vrai navigateur Chromium en arrière-plan,
              détecte les bugs et génère un rapport.
            </p>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-400">
            <span className="font-semibold">Erreur :</span> {error}
          </div>
        )}

        {busy && !report && (
          <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card/40 p-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Lancement du navigateur, ouverture du projet…
          </div>
        )}

        {report && (
          <div className="space-y-3 text-xs">
            {/* Verdict */}
            <div
              className={`flex items-start gap-2.5 rounded-lg border p-3 ${
                report.status === "ok"
                  ? "border-emerald-500/40 bg-emerald-500/10"
                  : report.status === "warn"
                    ? "border-amber-500/40 bg-amber-500/10"
                    : "border-red-500/40 bg-red-500/10"
              }`}
            >
              <StatusIcon className={`mt-0.5 h-4 w-4 ${STATUS_META[report.status].color}`} />
              <div className="flex-1">
                <div className={`text-sm font-semibold ${STATUS_META[report.status].color}`}>
                  {STATUS_META[report.status].label}
                </div>
                <div className="mt-0.5 text-foreground">{report.summary}</div>
                <div className="mt-1 text-[10px] text-muted-foreground">
                  Loaded in {report.navigation.loadTimeMs}ms · Tested in {report.durationMs}ms
                  {report.navigation.title ? ` · "${report.navigation.title}"` : ""}
                </div>
              </div>
            </div>

            {/* Send to builder */}
            {report.recommendations.length > 0 && onSendToBuilder && (
              <button
                onClick={sendBugReportToBuilder}
                data-testid="qa-send-builder-btn"
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-primary/40 bg-primary/10 py-2.5 text-xs font-medium text-primary transition hover:bg-primary/20"
              >
                <Send className="h-3.5 w-3.5" /> Envoyer le rapport au Builder ({report.recommendations.length} bug{report.recommendations.length > 1 ? "s" : ""})
              </button>
            )}

            {/* Recommendations */}
            {report.recommendations.length > 0 && (
              <Section title="Recommandations" defaultOpen>
                <ul className="space-y-1.5">
                  {report.recommendations.map((r, i) => (
                    <li key={i} className="flex items-start gap-2 rounded bg-card/50 px-2 py-1.5">
                      <span className="text-amber-400">→</span>
                      <span className="text-foreground/90">{r}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {/* Page errors */}
            {report.pageErrors.length > 0 && (
              <Section title={`JS runtime errors (${report.pageErrors.length})`} defaultOpen>
                <ul className="space-y-1.5">
                  {report.pageErrors.map((e, i) => (
                    <li key={i} className="rounded bg-red-500/5 px-2 py-1.5 text-red-400">
                      <div className="font-mono text-[11px]">{e.message}</div>
                      {e.stack && (
                        <pre className="mt-0.5 whitespace-pre-wrap text-[10px] text-red-400/70">
                          {e.stack}
                        </pre>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {/* Console */}
            {report.console.length > 0 && (
              <Section title={`Console (${report.console.length})`}>
                <ul className="space-y-1">
                  {report.console.map((c, i) => (
                    <li
                      key={i}
                      className={`rounded px-2 py-1 font-mono text-[10px] ${
                        c.level === "error"
                          ? "bg-red-500/5 text-red-400"
                          : c.level === "warning"
                            ? "bg-amber-500/5 text-amber-400"
                            : "bg-card/40 text-muted-foreground"
                      }`}
                    >
                      [{c.level}] {c.text}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {/* Failed requests */}
            {report.failedRequests.length > 0 && (
              <Section title={`Failed requests (${report.failedRequests.length})`}>
                <ul className="space-y-1">
                  {report.failedRequests.map((r, i) => (
                    <li key={i} className="rounded bg-card/40 px-2 py-1 font-mono text-[10px]">
                      <span className="text-red-400">{r.method}</span> {r.url}
                      <span className="ml-2 text-muted-foreground">→ {r.status ?? "?"} ({r.reason})</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {/* UI summary */}
            <Section title="DOM analysis">
              <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                <Stat label="Body text" value={`${report.ui.bodyTextLength} chars`} />
                <Stat label="Visible buttons" value={String(report.ui.visibleButtons)} />
                <Stat label="Visible inputs" value={String(report.ui.visibleInputs)} />
                <Stat label="Images" value={`${report.ui.images.total - report.ui.images.broken}/${report.ui.images.total} ok`} />
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
                {Object.entries(report.ui.elementCounts)
                  .filter(([, v]) => v > 0)
                  .map(([k, v]) => (
                    <span
                      key={k}
                      className="rounded-full bg-card/60 px-2 py-0.5 font-mono text-muted-foreground"
                    >
                      &lt;{k}&gt; ×{v}
                    </span>
                  ))}
              </div>
            </Section>

            {/* Responsive */}
            <Section title="Responsive">
              <div className="space-y-1 text-[11px]">
                <RBadge ok={!report.responsive.desktopOverflow} label="Desktop fits viewport" />
                <RBadge ok={!report.responsive.mobileOverflow} label="Mobile (375px) fits viewport" />
              </div>
            </Section>

            {/* Screenshots */}
            {(report.screenshots.desktop || report.screenshots.mobile) && (
              <Section
                title="Screenshots"
                defaultOpen={showShots}
                onToggle={(o) => setShowShots(o)}
              >
                <div className="mb-2 flex gap-1">
                  <ShotTab
                    active={activeTab === "desktop"}
                    onClick={() => setActiveTab("desktop")}
                    icon={Monitor}
                    label="Desktop"
                  />
                  {report.screenshots.mobile && (
                    <ShotTab
                      active={activeTab === "mobile"}
                      onClick={() => setActiveTab("mobile")}
                      icon={Smartphone}
                      label="Mobile"
                    />
                  )}
                </div>
                <div className="overflow-hidden rounded border border-border bg-black/30">
                  {activeTab === "desktop" && report.screenshots.desktop && (
                    // eslint-disable-next-line jsx-a11y/alt-text
                    <img src={report.screenshots.desktop} className="w-full" />
                  )}
                  {activeTab === "mobile" && report.screenshots.mobile && (
                    // eslint-disable-next-line jsx-a11y/alt-text
                    <img src={report.screenshots.mobile} className="mx-auto max-w-[280px]" />
                  )}
                </div>
              </Section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  defaultOpen = false,
  children,
  onToggle,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  onToggle?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-border bg-card/40">
      <button
        onClick={() => {
          setOpen((o) => {
            const n = !o;
            onToggle?.(n);
            return n;
          });
        }}
        className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {title}
      </button>
      {open && <div className="border-t border-border px-2.5 py-2">{children}</div>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded bg-card/60 px-2 py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  );
}

function RBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded bg-card/60 px-2 py-1">
      {ok ? (
        <CheckCircle2 className="h-3 w-3 text-emerald-500" />
      ) : (
        <XCircle className="h-3 w-3 text-red-500" />
      )}
      <span className={ok ? "text-foreground" : "text-red-400"}>{label}</span>
    </div>
  );
}

function ShotTab({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ElementType;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] ${
        active ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground"
      }`}
    >
      <Icon className="h-3 w-3" /> {label}
    </button>
  );
}
