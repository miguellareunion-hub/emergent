import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Bot,
  Send,
  Sparkles,
  User2,
  Loader2,
  Settings as SettingsIcon,
  Wand2,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { FileNode } from "@/lib/projects";
import { buildPreviewDoc } from "@/lib/projects";
import { loadAISettings } from "@/lib/aiSettings";
import { loadAgentsSettings } from "@/lib/agentSettings";
import { loadRunnerSettings } from "@/lib/runnerSettings";
import { parseAgentOutput, type AgentAction } from "@/lib/agentActions";
import {
  clearRuntimeErrors,
  drainRuntimeErrors,
  type RuntimeError,
} from "@/lib/runtimeErrors";
import { validateProject, formatIssuesForFixer } from "@/lib/projectValidator";
import { detectIntent, MODIFY_GUARD_PROMPT } from "@/lib/intentDetector";
import { TOOL_DEFS, executeTool, type ToolCall, type ToolResult } from "@/lib/agentTools";

type AgentRole = "builder" | "fixer" | "planner";

type PlanStep = { title: string; instruction: string };

/** Heuristic: should we run the planner before the builder? */
function shouldPlan(prompt: string, minChars: number): boolean {
  const t = prompt.trim();
  if (t.length > minChars) return true;
  // Multi-line bulleted/numbered prompts
  const lines = t.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length >= 4) return true;
  const bulletLines = lines.filter((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l)).length;
  if (bulletLines >= 3) return true;
  return false;
}

/** Try to extract { steps: [...] } from a (possibly noisy) planner reply. */
function extractPlan(raw: string): PlanStep[] | null {
  // Strip markdown code fences if any
  const cleaned = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  // Find first { ... last }
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    const obj = JSON.parse(cleaned.slice(first, last + 1));
    if (!obj || !Array.isArray(obj.steps)) return null;
    const steps: PlanStep[] = obj.steps
      .map((s: unknown) => {
        if (typeof s === "string") return { title: s, instruction: s };
        if (s && typeof s === "object") {
          const o = s as Record<string, unknown>;
          const title = String(o.title ?? o.name ?? o.instruction ?? "");
          const instruction = String(o.instruction ?? o.description ?? o.title ?? "");
          if (!instruction) return null;
          return { title: title || instruction.slice(0, 40), instruction };
        }
        return null;
      })
      .filter((x: PlanStep | null): x is PlanStep => x !== null)
      .slice(0, 6);
    return steps.length > 0 ? steps : null;
  } catch {
    return null;
  }
}

type Msg = {
  role: "user" | "assistant";
  content: string;
  agentRole?: AgentRole;
  /** Native-tools mode: list of tool calls executed during this assistant turn. */
  toolEvents?: { label: string; ok: boolean }[];
};

interface Props {
  projectId: string;
  files: FileNode[];
  activeFile: FileNode | null;
  onOpenSettings?: () => void;
  onWriteFile: (path: string, content: string) => void;
  onRenameFile: (from: string, to: string) => void;
  onDeleteFile: (path: string) => void;
  /** Called after an agent applies file changes so the UI can show the preview. */
  onSwitchToPreview?: () => void;
  /** Callback used to read the *latest* file list synchronously between fix iterations. */
  getLatestFiles: () => FileNode[];
}

const SUGGESTIONS = [
  "Build a tic-tac-toe game",
  "Create a todo list app",
  "Make a landing page for a coffee shop",
  "Add a dark mode toggle",
];

/** Delay after applying files so the iframe runs and reports any errors. */
const RUNTIME_OBSERVE_MS = 1500;
const REPEATED_TOOL_ATTEMPT_LIMIT = 4;
const REPEATED_FAILURE_LIMIT = 3;
const NO_PROGRESS_TOOL_STEPS_LIMIT = 12;

function supportsReliableNativeTools(provider: "lovable" | "openai" | "lmstudio"): boolean {
  return provider !== "lmstudio";
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries
    .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`)
    .join(",")}}`;
}

function extractToolErrorSummary(content: string): string {
  try {
    const parsed = JSON.parse(content) as { error?: string; stderr?: string; body?: string };
    return parsed.error || parsed.stderr || parsed.body || content;
  } catch {
    return content;
  }
}

export function AgentChat({
  projectId,
  files,
  activeFile,
  onOpenSettings,
  onWriteFile,
  onRenameFile,
  onDeleteFile,
  onSwitchToPreview,
  getLatestFiles,
}: Props) {
  const storageKey = `lovable-ide:agent-chat:${projectId}`;
  const [messages, setMessages] = useState<Msg[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(`lovable-ide:agent-chat:${projectId}`);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as Msg[];
      return [];
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusLine, setStatusLineRaw] = useState<string>("");
  const abortRef = useRef<AbortController | null>(null);
  const sendRef = useRef<((text: string) => void) | null>(null);

  // Prevent accidental page reloads / navigation while the AI agent is
  // streaming / writing files. Without this guard, mobile pull-to-refresh,
  // the back button, or a swipe gesture would kill the in-flight stream and
  // lose the partially generated project.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!loading) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Required for the prompt to actually appear in older browsers.
      e.returnValue = "L'agent IA travaille — quitter va annuler la génération.";
      return e.returnValue;
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [loading]);

  // Persist chat history per-project so a page refresh doesn't wipe context.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (messages.length === 0) {
        window.localStorage.removeItem(storageKey);
      } else {
        // Cap stored history to avoid blowing up localStorage on long sessions.
        const trimmed = messages.slice(-200);
        window.localStorage.setItem(storageKey, JSON.stringify(trimmed));
      }
    } catch {
      // Ignore quota errors — chat will still work in-memory.
    }
  }, [messages, storageKey]);

  // Reload history when switching project (in case the component is reused).
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) {
        setMessages([]);
        return;
      }
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) setMessages(parsed as Msg[]);
    } catch {
      setMessages([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  /** Wrap setStatusLine so the RunnerPanel can show what the agent is doing in real time. */
  const setStatusLine = (s: string) => {
    setStatusLineRaw(s);
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("lovable:agent-status", { detail: { label: s } }),
      );
    }
  };

  // Listen for "Fix this error" buttons in the RunnerPanel (and any other source).
  useEffect(() => {
    const onFixError = (ev: Event) => {
      const detail = (ev as CustomEvent<{ error: string }>).detail;
      if (!detail?.error || !sendRef.current) return;
      const prompt = `Le Node Runner vient de produire cette erreur :\n\n\`\`\`\n${detail.error}\n\`\`\`\n\nIdentifie la cause et corrige les fichiers concernés.`;
      sendRef.current(prompt);
    };
    const onQAReport = (ev: Event) => {
      const detail = (ev as CustomEvent<{ message: string }>).detail;
      if (!detail?.message || !sendRef.current) return;
      sendRef.current(detail.message);
    };
    window.addEventListener("lovable:fix-runner-error", onFixError);
    window.addEventListener("lovable:qa-report-to-builder", onQAReport);
    return () => {
      window.removeEventListener("lovable:fix-runner-error", onFixError);
      window.removeEventListener("lovable:qa-report-to-builder", onQAReport);
    };
  }, []);

  const buildContext = (currentFiles: FileNode[], openName?: string) =>
    `Project files (current):\n${
      currentFiles.length === 0
        ? "(empty project — no files yet)"
        : currentFiles.map((f) => `--- ${f.name} ---\n${f.content}`).join("\n\n")
    }\n\nCurrently open file: ${openName ?? "(none)"}`;

  /**
   * Streams a single agent turn. Returns the raw assistant text and the
   * applied actions list.
   */
  const runAgentTurn = async (
    role: AgentRole,
    apiMessages: Msg[],
    signal: AbortSignal,
    /** Optional explicit prompt override (used by custom agents). */
    explicitOverride?: string,
    /** Optional label shown in chat (e.g. custom agent name). */
    displayLabel?: string,
  ): Promise<{ text: string; actions: AgentAction[] } | null> => {
    let assistantSoFar = "";
    setMessages((prev) => [
      ...prev,
      {
        role: "assistant",
        content: displayLabel ? `*${displayLabel}*\n\n` : "",
        agentRole: role,
      },
    ]);
    if (displayLabel) assistantSoFar = `*${displayLabel}*\n\n`;

    const upsert = (chunk: string) => {
      assistantSoFar += chunk;
      setMessages((prev) =>
        prev.map((m, i) =>
          i === prev.length - 1 && m.role === "assistant"
            ? { ...m, content: assistantSoFar }
            : m,
        ),
      );
    };

    const settings = loadAISettings();
    const agentsSettings = loadAgentsSettings();
    const override =
      explicitOverride !== undefined
        ? explicitOverride.trim()
        : agentsSettings[role].systemPrompt.trim();
    const isLmStudio = settings.provider === "lmstudio";

    const builtInLmStudioPrompt =
      role === "fixer"
        ? "You are the FIXER agent inside Lovable IDE. Re-emit broken files in full using <lov-write path=\"...\">...</lov-write> tags. Use <lov-delete path=\"...\" /> to remove files. Keep filenames at root. Output COMPLETE files."
        : role === "planner"
          ? "You are the PLANNER agent inside Lovable IDE. Split a complex user request into 2-6 small ordered build steps. Output ONLY JSON: { \"steps\": [ { \"title\": \"...\", \"instruction\": \"...\" } ] }. Step 1 is the base structure (HTML+CSS+JS skeleton). Each next step adds ONE feature on top. No prose, no markdown fences, no extra keys."
          : "You are the BUILDER agent inside Lovable IDE. Generate browser-only projects (HTML/CSS/JS). To create or overwrite a file, emit it like:\n<lov-write path=\"index.html\">\n<!doctype html>\n<html>...real code here...</html>\n</lov-write>\nNEVER write the literal words FULL CONTENT, FULL FILE CONTENT, or any placeholder — always inline the actual code. Use <lov-delete path=\"...\" /> to delete. Keep filenames at root. Always output COMPLETE files. When <context> already lists files, ADD or PATCH only what the current step needs — do not recreate everything from scratch.";

    const lmStudioSystemPrompt = override.length > 0 ? override : builtInLmStudioPrompt;

    const lmStudioHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (isLmStudio && settings.lmstudioApiKey.trim()) {
      lmStudioHeaders["Authorization"] = `Bearer ${settings.lmstudioApiKey.trim()}`;
    }

    const resp = isLmStudio
      ? await fetch(`${settings.lmstudioBaseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: lmStudioHeaders,
          body: JSON.stringify({
            model: settings.lmstudioModel,
            stream: true,
            messages: [
              { role: "system", content: lmStudioSystemPrompt },
              ...apiMessages.map((m) => ({ role: m.role, content: m.content })),
            ],
          }),
          signal,
        })
      : await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            role,
            messages: apiMessages.map((m) => ({ role: m.role, content: m.content })),
            provider: settings.provider,
            model:
              settings.provider === "openai" ? settings.openaiModel : settings.lovableModel,
            openaiApiKey: settings.provider === "openai" ? settings.openaiApiKey : undefined,
            systemPromptOverride: override.length > 0 ? override : undefined,
          }),
          signal,
        });

    if (!resp.ok || !resp.body) {
      let msg = `Failed to reach the AI agent (HTTP ${resp.status}).`;
      try {
        const text = await resp.text();
        try {
          const j = JSON.parse(text);
          const errVal = j?.error ?? j?.message ?? j?.error?.message;
          if (typeof errVal === "string") msg = errVal;
          else if (errVal && typeof errVal === "object") msg = JSON.stringify(errVal);
          else if (text) msg = text.slice(0, 300);
        } catch {
          if (text) msg = text.slice(0, 300);
        }
      } catch {}
      upsert(`⚠️ ${msg}`);
      return null;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    while (!done) {
      const { done: d, value } = await reader.read();
      if (d) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line || line.startsWith(":")) continue;
        if (!line.startsWith("data: ")) continue;
        const json = line.slice(6).trim();
        if (json === "[DONE]") {
          done = true;
          break;
        }
        try {
          const parsed = JSON.parse(json);
          const content = parsed.choices?.[0]?.delta?.content as string | undefined;
          if (content) upsert(content);
        } catch {
          buffer = line + "\n" + buffer;
          break;
        }
      }
    }

    const { actions } = parseAgentOutput(assistantSoFar);
    return { text: assistantSoFar, actions };
  };

  const applyActions = (actions: AgentAction[], allowDelete = false) => {
    const failures: string[] = [];
    for (const a of actions) {
      try {
        if (a.type === "write") {
          onWriteFile(a.path, a.content);
          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("lovable:agent-file-write", { detail: { path: a.path } }),
            );
          }
        } else if (a.type === "rename") {
          onRenameFile(a.from, a.to);
          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("lovable:agent-file-write", { detail: { path: `${a.from} → ${a.to}` } }),
            );
          }
        } else if (a.type === "delete") {
          if (!allowDelete) {
            // Silently refuse — protects users from delete-loop bugs.
            failures.push(
              `🛡️ Suppression de ${a.path} bloquée (le prompt n'a pas demandé de supprimer ce fichier).`,
            );
            continue;
          }
          onDeleteFile(a.path);
          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("lovable:agent-file-write", { detail: { path: `🗑 ${a.path}` } }),
            );
          }
        }
      } catch (e) {
        console.error("Failed to apply agent action", a, e);
        const message = e instanceof Error ? e.message : "Unknown write error";
        failures.push(
          a.type === "write"
            ? `Impossible d'écrire ${a.path}: ${message}`
            : a.type === "rename"
              ? `Impossible de renommer ${a.from}: ${message}`
              : `Impossible de supprimer ${a.path}: ${message}`,
        );
      }
    }
    return failures;
  };

  /** Wait for the iframe to render and collect any runtime errors that occur. */
  const observeRuntime = async (sinceTs: number): Promise<RuntimeError[]> => {
    await new Promise((r) => setTimeout(r, RUNTIME_OBSERVE_MS));
    return drainRuntimeErrors(sinceTs);
  };

  /**
   * QA report shape returned by /api/qa. Subset of the fields we care about
   * inside the build loop.
   */
  type QAReport = {
    status: "ok" | "warn" | "fail";
    summary: string;
    durationMs: number;
    pageErrors: { message: string }[];
    failedRequests: { url: string; method: string; status: number | null; reason: string }[];
    console: { level: string; text: string }[];
    ui: {
      images: { broken: number };
      missingExpected: string[];
    };
    navigation: { blank: boolean; httpStatus: number | null; title: string };
    responsive: { mobileOverflow: boolean };
    recommendations: string[];
  };

  /**
   * Run the QA_AGENT against the current set of files. Returns null if the
   * QA endpoint can't be reached (offline / unsupported) so the caller can
   * fall back gracefully.
   */
  const runQAValidation = async (
    signal: AbortSignal,
  ): Promise<QAReport | null> => {
    try {
      setStatusLine("🤖 QA_AGENT teste l'app dans Chromium…");
      const runner = loadRunnerSettings();
      const html = buildPreviewDoc(getLatestFiles());
      const res = await fetch("/api/qa", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${runner.token || "lovable-ide-local"}`,
        },
        body: JSON.stringify({ html, testMobile: true, timeoutMs: 9000 }),
        signal,
      });
      if (!res.ok) return null;
      return (await res.json()) as QAReport;
    } catch {
      return null;
    }
  };

  /**
   * Compose a single user-message that bundles whatever runtime errors the
   * iframe captured AND whatever the QA_AGENT found, so the agent can fix
   * everything in one targeted next pass.
   */
  const buildAutoFixPrompt = (
    runtimeErrors: RuntimeError[],
    qa: QAReport | null,
  ): string => {
    const sections: string[] = [
      "🚨 The build is NOT validated yet. Fix the issues below and call `finish` again. Do NOT delete files.",
    ];
    if (runtimeErrors.length > 0) {
      sections.push(
        "**Runtime errors observed in the preview iframe:**\n" +
          runtimeErrors
            .slice(0, 8)
            .map((e, i) => `${i + 1}. [${e.level || "error"}] ${e.msg}`)
            .join("\n"),
      );
    }
    if (qa) {
      sections.push(`**QA_AGENT verdict:** ${qa.summary}`);
      if (qa.pageErrors.length > 0)
        sections.push(
          "**JS runtime errors (Playwright):**\n" +
            qa.pageErrors.slice(0, 5).map((e, i) => `${i + 1}. ${e.message}`).join("\n"),
        );
      if (qa.failedRequests.length > 0)
        sections.push(
          "**Failed network requests:**\n" +
            qa.failedRequests
              .slice(0, 5)
              .map((r, i) => `${i + 1}. ${r.method} ${r.url} → ${r.status ?? "?"} (${r.reason})`)
              .join("\n"),
        );
      if (qa.navigation.blank) sections.push("**Page apparaît BLANCHE** — le DOM est vide ou non rendu.");
      if (qa.responsive.mobileOverflow) sections.push("**Layout cassé sur mobile (375px)** — débordement horizontal détecté.");
      if (qa.ui.images.broken > 0) sections.push(`**${qa.ui.images.broken} image(s) cassée(s)** — vérifie les chemins src=.`);
      if (qa.ui.missingExpected.length > 0)
        sections.push(`**Éléments UI manquants :** ${qa.ui.missingExpected.join(", ")}`);
      if (qa.recommendations.length > 0)
        sections.push(
          "**Actions recommandées :**\n" +
            qa.recommendations.map((r) => `- ${r}`).join("\n"),
        );
    }
    sections.push(
      "Diagnose the root cause for each issue, patch ONLY the file(s) that need to change with `write_file` (full content), then call `finish`. The QA_AGENT will re-validate.",
    );
    return sections.join("\n\n");
  };

  /**
   * Native-tool-calling loop. The agent receives JSON-schema tool definitions
   * (read_file, write_file, exec_shell, web_search, …) and we run them in a
   * loop until it calls `finish` or hits the iteration cap.
   *
   * This mirrors how the IDE's own meta-agent works: the model decides what
   * to do, we execute it, we send back the result, repeat.
   */
  const runAgentToolLoop = async (
    initialUserPrompt: string,
    controller: AbortController,
  ): Promise<boolean> => {
    const settings = loadAISettings();
    const agentsSettings = loadAgentsSettings();
    const isLmStudio = settings.provider === "lmstudio";

    // Build initial system prompt — combines the Builder role with explicit
    // tool-using instructions.
    const builderOverride = agentsSettings.builder.systemPrompt.trim();
    const baseRole = builderOverride.length > 0
      ? builderOverride
      : "You are the BUILDER agent of Lovable IDE. You design and ship working projects.";

    const systemPrompt = `${baseRole}

# 🛡️ ABSOLUTE TOP PRIORITY RULE — NO DELETE
**NEVER call \`delete_file\` UNLESS the user's CURRENT message contains the explicit French/English word "supprime", "delete", or "remove" naming that exact file.**
- If the user is asking you to CREATE / BUILD a project, your job is ONLY to write files. Deleting any file in this scenario is FORBIDDEN and counts as failure.
- If the user is asking for a MODIFICATION, only \`write_file\` to update the relevant files. NEVER delete.
- If you think a file "looks unused", LEAVE IT ALONE. The user wants it.
- This rule overrides every other rule below. If in doubt → do not delete.

# 📁 FILE LAYOUT — INDEX.HTML CONVENTIONS (read carefully)
The IDE preview shows EITHER \`index.html\` at the project root OR \`public/index.html\` (Node.js/Express convention).
- For BROWSER-only projects (no package.json), put \`index.html\`, \`style.css\`, \`script.js\` at the **project root**.
- For NODE.JS projects with an Express server serving static files, put the frontend under \`public/\` (so: \`public/index.html\`, \`public/style.css\`, \`public/app.js\`). The server.js does \`app.use(express.static('public'))\`.
- **NEVER mix both**: if you put your UI under \`public/\`, do NOT also create a root \`index.html\` (and vice-versa). Pick one place and stick to it.
- If \`list_files\` shows leftover files from a previous build that conflict (e.g. an old root \`index.html\` while you're building under \`public/\`), DO NOT delete them — instead, write the new files under \`public/\` AND update the root \`index.html\` so it just redirects/iframes the public one, OR simply leave it (the preview will still pick public/index.html as fallback).

# TOOLS YOU CAN CALL
- \`list_files\` / \`read_file\` — inspect the project (projectId="${projectId}").
- \`write_file\` / \`rename_file\` — apply COMPLETE file content (no diffs, no placeholders).
- \`delete_file\` — ONLY when the user explicitly asks for it (see rule above).
- \`exec_shell\` — run a command in the project workspace. Often unavailable: see "RUNNER" below.
- \`http_fetch\` — call an HTTP endpoint from the runner. Often unavailable: see "RUNNER".
- \`web_search\` — search the web for docs, error messages, API syntax, library versions.
- \`finish\` — declare the task done with a short summary. Stop calling tools after this.

# 🔥 SENIOR-DEV MINDSET (this is what makes you USEFUL, not just a code generator)
You are not a code-suggestion bot. You are a senior engineer who SHIPS WORKING projects.
- Write the code → run it → observe → fix what's broken → repeat. Don't just hope.
- If \`exec_shell\` returns a non-zero exit code, READ stderr, fix the code, re-run.
- If \`http_fetch\` returns a 4xx/5xx, the server is misconfigured — fix it before claiming done.
- If you wrote 10 files and one of them has a typo, it's still broken. Test it.
- Querying a DOM element that doesn't exist (\`Cannot set properties of null\`) is YOUR fault — your script ran before the element existed, OR the id is wrong, OR the element was never created. Find the root cause.
- "It probably works" is not acceptable. Verify.

# 🤖 QA_AGENT AUTO-VALIDATION (this is critical)
After you call \`finish\`, the system AUTOMATICALLY runs:
  1. A live runtime-error scan on the preview iframe.
  2. The **QA_AGENT** — a real headless Chromium (Playwright) that opens the project, observes 1.5s, then reports every detectable problem: blank page, JS errors, broken images, failed network requests, missing UI elements, responsive overflow at 375px, etc.

This means:
- You CAN safely call \`finish\` once you've written all files. The QA_AGENT will tell you what's broken.
- If issues come back as a follow-up user message starting with "🚨", DO NOT panic, DO NOT delete files. Just:
  1. Read each problem carefully (the message lists JS errors, failed requests, missing elements, responsive issues, recommendations).
  2. Identify the root cause file by file.
  3. \`read_file\` if needed.
  4. \`write_file\` ONLY the file(s) that fix the listed problems.
  5. Call \`finish\` again. The QA_AGENT will re-validate.
- Only when the QA_AGENT returns "✅ Project loaded cleanly with no detectable issues" is the build truly done.

# 🚨 COMMON QA FINDINGS AND THEIR FIXES
  - **Cannot set properties of null (setting 'textContent')** → \`document.getElementById('foo')\` returned null. Either the id is wrong, OR your script ran before the element was rendered. Wrap your init in \`document.addEventListener('DOMContentLoaded', () => {...})\` OR move the \`<script>\` tag to the END of \`<body>\` (after the elements). Check that every \`getElementById\` call has a matching \`<element id="...">\` in the HTML.
  - **Cannot read properties of undefined (reading 'X')** → an object is undefined. Add \`?.\` optional chaining or guard with \`if (obj) {...}\`.
  - **X is not defined** → missing import, typo in variable name, or the script that defines X is loaded AFTER the script that uses X.
  - **SyntaxError: Unexpected token** → real syntax error in YOUR code. Read the file, fix it.

# RUNNER — AVAILABLE BY DEFAULT IN THIS IDE ✅
The built-in Node Runner is configured out of the box. You CAN and SHOULD use:
- \`exec_shell\` to run \`npm install\`, \`node server.js\`, \`node -c file.js\`, \`ls\`, \`cat\`, \`git\`, etc.
- \`http_fetch\` to curl your own running server or public APIs.

The runner materialises every project file to a private workspace on disk before running the command. So \`node server.js\` will actually execute the code you just wrote with \`write_file\`.

If (and only if) \`exec_shell\` ever returns \`{ "skipped": true, ... }\`, THEN the runner is offline — fall back to writing files only and call \`finish\`. Otherwise: always test the project end-to-end before calling finish.


# HOW TO WORK (mandatory)
1. **Understand first**: call \`list_files\` ONCE at the very start, then \`read_file\` only on files you intend to modify.
2. **Plan in 1 short sentence** in plain text before acting.
3. **Targeted edits**: only re-emit files that actually change. Preserve names, exports, ids, classes.
4. **Batch big projects**: when the user asks you to create N files (>5), emit \`write_file\` calls for ALL of them across one or two assistant turns. Don't pause for unnecessary status updates.
5. **For Node.js projects WHEN the runner IS available**:
   a. Make sure \`package.json\` lists every imported package and a valid \`scripts.start\`.
   b. Run \`npm install\` ONCE. If it fails, read the error, fix package.json, retry once.
   c. Run \`node -c <entry>.js\` to check syntax of the entrypoint.
   d. Start the app with \`timeoutMs: 5000\` so the call returns even if the server stays up.
   e. Verify with \`http_fetch\` against the running server. A 2xx/3xx response = success.
   f. Call \`finish\`.
6. **For Node.js projects WHEN the runner is NOT available** (most common in this IDE):
   a. Write every file listed by the user (or that your design needs) with \`write_file\`.
   b. Make sure \`package.json\` is correct (deps, scripts.start = "node server.js" or similar).
   c. Call \`finish\` with run instructions for the user.
7. **Pure browser projects** (HTML/CSS/JS, no package.json): write the files; the iframe preview runs them automatically. Then \`finish\`.

# WRITING FILES — HARD RULES
- ALWAYS pass the COMPLETE final code in \`content\`. Never the words "FULL CONTENT", "...", "<file content>" or any placeholder — these are rejected.
- Never write a file you have not read first if it already exists.
- Never re-emit a file that does not need to change.
- For BIG projects: it's better to call \`write_file\` MANY times in the same assistant turn (parallel tool_calls) than to spread them across many turns.

# DEBUGGING — THE GOLDEN LOOP (only when runner is available)
When a tool returns an error you MUST react like a senior engineer, not by retrying blindly.

1. **Read the FULL error** (stderr, exit code, stack trace). Quote the key line in plain text.
2. **Diagnose the root cause** in one sentence: missing dep, wrong path, syntax error, version mismatch, port already in use, missing env var, wrong package name, etc.
3. **Pick the right fix**:
   - Cannot find module 'X' → check package.json, run \`npm install X\` if it's a real package, otherwise fix the import.
   - npm ERR! 404 / E404 → the package name is wrong. \`web_search\` for the correct name BEFORE editing package.json again.
   - SyntaxError / ReferenceError → \`read_file\` the file at the reported line, fix the code, re-run.
   - EADDRINUSE → another process holds the port; either change PORT or stop and restart, do NOT loop \`npm start\`.
   - ERR_REQUIRE_ESM / Cannot use import statement → fix \`"type": "module"\` in package.json or convert require/import accordingly.
4. **Apply ONE focused fix** with \`write_file\`, then **re-run the failing command exactly once** to verify.
5. **Stop and \`finish\`** if the same command fails twice with the same error after a fix.
6. **NEVER fix an error by deleting the broken file** — fix the code inside it.

# HARD RULES
- Never repeat an identical failing tool call without changing a relevant file first.
- Never re-run \`npm install\` more than twice in a row; if it keeps failing, the root cause is in package.json.
- ABSOLUTELY NEVER delete a file the user did not ask to delete.
- Always emit COMPLETE file content with \`write_file\`.
- Always end the session with a \`finish\` tool call.
- If the user asks for many files (>5), DO NOT stop after the first few — keep going until every file in the spec exists, THEN finish.`;

    // Conversation history we send to the model. Tool messages get appended
    // as we go.
    type ApiMsg = {
      role: "system" | "user" | "assistant" | "tool";
      content: string | null;
      tool_call_id?: string;
      tool_calls?: unknown;
      name?: string;
    };
    const history: ApiMsg[] = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `${initialUserPrompt}\n\n<currently_open_file>${activeFile?.name ?? "(none)"}</currently_open_file>`,
      },
    ];

    // The visible assistant bubble we update as we go.
    let visibleContent = "";
    const toolEvents: { label: string; ok: boolean }[] = [];
    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: "", agentRole: "builder", toolEvents: [] },
    ]);
    const updateBubble = () => {
      setMessages((prev) =>
        prev.map((m, i) =>
          i === prev.length - 1 && m.role === "assistant"
            ? { ...m, content: visibleContent, toolEvents: [...toolEvents] }
            : m,
        ),
      );
    };

    const ctx = {
      projectId,
      getFiles: getLatestFiles,
      onWriteFile,
      onRenameFile,
      onDeleteFile,
    };

    // ---- DELETE GUARD ----
    // The agent must NEVER delete files unless the user explicitly asked for it.
    // We compute this once from the original user prompt and refuse delete_file
    // calls that don't match.
    const userAllowsDelete = /\b(supprime|supprimer|efface|effacer|delete|remove)\b/i.test(
      initialUserPrompt,
    );

    const maxIters = Math.max(1, agentsSettings.maxToolIterations || 24);
    const toolAttemptCounts = new Map<string, number>();
    const toolFailureCounts = new Map<string, number>();
    let nonProgressSteps = 0;

    for (let iter = 0; iter < maxIters; iter++) {
      if (controller.signal.aborted) return false;
      setStatusLine(`Agent réfléchit… (étape ${iter + 1}/${maxIters})`);

      // Call the model in non-streaming mode so we can parse tool_calls cleanly.
      const reqUrl = isLmStudio
        ? `${settings.lmstudioBaseUrl.replace(/\/$/, "")}/chat/completions`
        : "/api/chat";

      const reqBody: Record<string, unknown> = isLmStudio
        ? {
            model: settings.lmstudioModel,
            stream: false,
            messages: history,
            tools: TOOL_DEFS,
            tool_choice: "auto",
          }
        : {
            role: "builder",
            messages: history.filter((m) => m.role !== "system"),
            provider: settings.provider,
            model:
              settings.provider === "openai" ? settings.openaiModel : settings.lovableModel,
            openaiApiKey: settings.provider === "openai" ? settings.openaiApiKey : undefined,
            systemPromptOverride: systemPrompt,
            tools: TOOL_DEFS,
            tool_choice: "auto",
            nonStreaming: true,
          };

      const reqHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (isLmStudio && settings.lmstudioApiKey.trim()) {
        reqHeaders["Authorization"] = `Bearer ${settings.lmstudioApiKey.trim()}`;
      }

      let resp: Response;
      try {
        resp = await fetch(reqUrl, {
          method: "POST",
          headers: reqHeaders,
          body: JSON.stringify(reqBody),
          signal: controller.signal,
        });
      } catch (e) {
        visibleContent += `\n⚠️ Connexion échouée: ${(e as Error).message}`;
        updateBubble();
        return false;
      }

      if (!resp.ok) {
        let errMsg = `HTTP ${resp.status}`;
        try {
          const t = await resp.text();
          try {
            const j = JSON.parse(t);
            errMsg = j.error || j.message || errMsg;
          } catch {
            errMsg = t.slice(0, 300) || errMsg;
          }
        } catch { /* */ }
        visibleContent += `\n⚠️ ${errMsg}`;
        updateBubble();
        return false;
      }

      const json = await resp.json();
      const choice = json?.choices?.[0];
      const message = choice?.message || {};
      const assistantText: string = message.content || "";
      const toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> =
        Array.isArray(message.tool_calls) ? message.tool_calls : [];

      // Append assistant message (with tool_calls) to history exactly as
      // received — required for the next round of tool messages to be valid.
      history.push({
        role: "assistant",
        content: assistantText || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });

      if (assistantText) {
        visibleContent += (visibleContent ? "\n\n" : "") + assistantText;
        updateBubble();
      }

      if (toolCalls.length === 0) {
        // No tool calls and no `finish` — model decided it's done. Stop.
        setStatusLine("");
        return true;
      }

      let sawFinish = false;
      let appliedFileChange = false;
      for (const tc of toolCalls) {
        if (controller.signal.aborted) return false;
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = tc.function.arguments
            ? JSON.parse(tc.function.arguments)
            : {};
        } catch {
          parsedArgs = {};
        }
        const call: ToolCall = {
          id: tc.id,
          name: tc.function.name,
          args: parsedArgs,
        };

        // ---- DELETE GUARD: refuse delete_file unless the user asked for it ----
        if (call.name === "delete_file" && !userAllowsDelete) {
          const blockedPath = String(call.args?.path ?? "(unknown)");
          const refusal: ToolResult = {
            ok: false,
            label: `🛡️ Suppression refusée : ${blockedPath}`,
            content: JSON.stringify({
              blocked: true,
              error:
                "delete_file is FORBIDDEN: the user did not ask to delete any file. Use write_file to update the project, never delete. Continue building.",
            }),
          };
          toolEvents.push({ label: refusal.label, ok: refusal.ok });
          updateBubble();
          history.push({
            role: "tool",
            tool_call_id: tc.id,
            name: tc.function.name,
            content: refusal.content,
          });
          nonProgressSteps += 1;
          continue;
        }

        const signature = `${call.name}:${stableStringify(call.args)}`;
        toolAttemptCounts.set(signature, (toolAttemptCounts.get(signature) ?? 0) + 1);
        setStatusLine(`🔧 ${call.name}…`);
        const result: ToolResult = await executeTool(call, ctx);
        toolEvents.push({ label: result.label, ok: result.ok });
        updateBubble();

        if (!result.ok) {
          const failureKey = `${signature}::${result.content}`;
          toolFailureCounts.set(failureKey, (toolFailureCounts.get(failureKey) ?? 0) + 1);
          const failureCount = toolFailureCounts.get(failureKey) ?? 0;
          const attemptCount = toolAttemptCounts.get(signature) ?? 0;
          const blocker = extractToolErrorSummary(result.content).slice(0, 240);

          if (failureCount >= REPEATED_FAILURE_LIMIT || attemptCount >= REPEATED_TOOL_ATTEMPT_LIMIT) {
            visibleContent += `\n\n⚠️ Arrêt automatique : l’agent répète \`${call.name}\` sans progrès. Blocage détecté : ${blocker}`;
            updateBubble();
            setStatusLine("");
            return true;
          }
        }

        if (["write_file", "rename_file", "delete_file"].includes(call.name)) {
          appliedFileChange = true;
          nonProgressSteps = 0;
          toolAttemptCounts.clear();
          toolFailureCounts.clear();
        } else {
          nonProgressSteps += 1;
        }

        history.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.function.name,
          content: result.content,
        });

        if (call.name === "finish") sawFinish = true;
      }

      if (!appliedFileChange && nonProgressSteps >= NO_PROGRESS_TOOL_STEPS_LIMIT) {
        visibleContent +=
          "\n\n⚠️ Arrêt automatique : trop d’actions sans modification de fichier. L’agent doit conclure ou changer de stratégie.";
        updateBubble();
        setStatusLine("");
        return true;
      }

      if (appliedFileChange) onSwitchToPreview?.();
      if (sawFinish) {
        // ---- AUTO-VALIDATION CYCLE ----
        // The agent declared "finished". We now run TWO validations before
        // declaring success:
        //   1. Quick runtime-error scan from the live preview iframe.
        //   2. Full QA_AGENT pass — Playwright opens the project in a real
        //      headless Chromium and reports every detectable problem
        //      (blank page, JS errors, broken images, responsive overflow,
        //      missing UI elements, failed requests, ...).
        // If either step reports issues, we feed them back to the agent and
        // let it loop — up to maxFixIterations times.
        const observed = await observeRuntime(Date.now());
        const qaReport = await runQAValidation(controller.signal);
        const hasIssues =
          observed.length > 0 || (qaReport && qaReport.status !== "ok");
        if (!hasIssues) {
          if (qaReport) {
            visibleContent +=
              `\n\n${qaReport.summary} _(QA_AGENT validated the build in ${qaReport.durationMs}ms)_`;
            updateBubble();
          }
          setStatusLine("");
          return true;
        }
        const maxAutoFixes = Math.max(1, agentsSettings.maxFixIterations || 3);
        for (let fixIter = 1; fixIter <= maxAutoFixes; fixIter++) {
          if (controller.signal.aborted) break;
          const liveErrors = fixIter === 1 ? observed : await observeRuntime(Date.now());
          const qa =
            fixIter === 1 ? qaReport : await runQAValidation(controller.signal);
          const stillIssues =
            liveErrors.length > 0 || (qa && qa.status !== "ok");
          if (!stillIssues) break;
          setStatusLine(
            `🛠 QA_AGENT auto-fix (passe ${fixIter}/${maxAutoFixes}) — ${qa?.recommendations.length ?? liveErrors.length} problème(s)…`,
          );
          const fixPrompt = buildAutoFixPrompt(liveErrors, qa);
          history.push({ role: "user", content: fixPrompt });
          sawFinish = false;
          nonProgressSteps = 0;
          toolAttemptCounts.clear();
          toolFailureCounts.clear();
          break;
        }
        if (sawFinish) {
          setStatusLine("");
          return true;
        }
        // Otherwise fall through and continue the outer for-loop.
      }
    }

    visibleContent += `\n\n⚠️ Limite de ${maxIters} étapes atteinte. Arrêt.`;
    updateBubble();
    setStatusLine("");
    return true;
  };


  /** Run a single builder + fixer cycle for one instruction (an entire prompt OR one plan step). */
  const runBuildCycle = async (
    instruction: string,
    priorMessages: Msg[],
    controller: AbortController,
    stepLabel?: string,
    /** Optional intent override (for plan steps we always treat them as targeted). */
    intentOverride?: "modify" | "create",
  ): Promise<boolean> => {
    const agentsSettings = loadAgentsSettings();
    if (!agentsSettings.builder.enabled) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            "⚠️ Le Builder est désactivé. Active-le dans **Agents** pour générer du code.",
        },
      ]);
      return false;
    }

    clearRuntimeErrors();
    const currentFiles = getLatestFiles();
    const intent =
      intentOverride ?? detectIntent(instruction, currentFiles.length > 0);
    const guardBlock =
      intent === "modify"
        ? `${MODIFY_GUARD_PROMPT}\n\n`
        : "";
    if (intent === "modify") {
      setStatusLine("Mode modification ciblée détecté — édition minimale…");
    }
    // Only allow delete when the user explicitly asked for it.
    const allowDelete = /\b(supprime|supprimer|efface|effacer|delete|remove)\b/i.test(
      instruction,
    );
    const prefix = stepLabel ? `${stepLabel}\n\n` : "";
    const builderUserMsg: Msg = {
      role: "user",
      content: `${guardBlock}${prefix}${instruction}\n\n<context>\n${buildContext(currentFiles, activeFile?.name)}\n</context>`,
    };
    const builderHistory: Msg[] = [...priorMessages, builderUserMsg];
    const builderResult = await runAgentTurn("builder", builderHistory, controller.signal);
    if (!builderResult) return false;
    const builderFailures = applyActions(builderResult.actions, allowDelete);
    if (builderFailures.length > 0) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `⚠️ ${builderFailures.join("\n")}` },
      ]);
      return false;
    }
    if (builderResult.actions.length > 0) onSwitchToPreview?.();

    // ---- Custom builder agents: run as additional refinement passes ----
    let lastBuilderText = builderResult.text;
    const customBuilders = agentsSettings.customAgents.filter(
      (a) => a.enabled && a.role === "builder",
    );
    for (const ca of customBuilders) {
      if (controller.signal.aborted) break;
      setStatusLine(`Agent custom « ${ca.name} » en cours…`);
      const caUserMsg: Msg = {
        role: "user",
        content:
          `${prefix}${instruction}\n\n` +
          `<context>\n${buildContext(getLatestFiles(), activeFile?.name)}\n</context>\n\n` +
          `The Builder above produced the previous assistant message. Improve, refine or extend the project according to your role. Use <lov-write>/<lov-delete> to apply changes. If nothing needs to change, just briefly say so.`,
      };
      const caHistory: Msg[] = [
        ...priorMessages,
        builderUserMsg,
        { role: "assistant", content: lastBuilderText },
        caUserMsg,
      ];
      const caResult = await runAgentTurn(
        "builder",
        caHistory,
        controller.signal,
        ca.systemPrompt,
        `${ca.emoji} ${ca.name}`,
      );
      if (!caResult) break;
      const caFailures = applyActions(caResult.actions, allowDelete);
      if (caFailures.length > 0) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `⚠️ ${caFailures.join("\n")}` },
        ]);
        break;
      }
      if (caResult.actions.length > 0) onSwitchToPreview?.();
      lastBuilderText = caResult.text;
    }

    // Fixer loop (skipped entirely if disabled or maxFixIterations === 0)
    if (!agentsSettings.fixer.enabled || agentsSettings.maxFixIterations <= 0) {
      return true;
    }

    let lastAssistantText = builderResult.text;
    for (let iter = 1; iter <= agentsSettings.maxFixIterations; iter++) {
      if (controller.signal.aborted) break;

      // 1. Static pre-run validation (catches export/import mismatches BEFORE running)
      const validationIssues = validateProject(getLatestFiles());

      // 2. Runtime errors collected from the iframe preview AND the Node runner
      setStatusLine(`Vérification du projet (passe ${iter}/${agentsSettings.maxFixIterations})…`);
      const checkpoint = Date.now() - 50;
      const runtimeErrs = await observeRuntime(checkpoint);

      const totalProblems = validationIssues.length + runtimeErrs.length;
      if (totalProblems === 0) {
        setStatusLine("");
        break;
      }

      const errorBlock = [
        validationIssues.length > 0
          ? `## Static validation issues (detected before run)\n${formatIssuesForFixer(validationIssues)}`
          : "",
        runtimeErrs.length > 0
          ? `## Runtime errors (from preview / Node runner)\n${runtimeErrs.map((e) => `- ${e.msg}`).join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      setStatusLine(
        `Fixer agent : ${totalProblems} problème${totalProblems > 1 ? "s" : ""} détecté${totalProblems > 1 ? "s" : ""}. Correction en cours (passe ${iter}/${agentsSettings.maxFixIterations})…`,
      );

      const fixerUserMsg: Msg = {
        role: "user",
        content:
          `The previous code has problems that need fixing.\n\n` +
          `${errorBlock}\n\n` +
          `<context>\n${buildContext(getLatestFiles())}\n</context>\n\n` +
          `Fix the ROOT cause of every problem above. Re-emit ONLY the file(s) that need changes using <lov-write>. ` +
          `If you change exports in one file, also re-check every file that imports from it.`,
      };
      const fixerHistory: Msg[] = [
        { role: "assistant", content: lastAssistantText },
        fixerUserMsg,
      ];
      const fixerResult = await runAgentTurn("fixer", fixerHistory, controller.signal);
      if (!fixerResult) break;
      const fixerFailures = applyActions(fixerResult.actions, allowDelete);
      if (fixerFailures.length > 0) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `⚠️ ${fixerFailures.join("\n")}` },
        ]);
        break;
      }
      lastAssistantText = fixerResult.text;
      if (fixerResult.actions.length > 0) onSwitchToPreview?.();

      // ---- Custom fixer agents: extra repair passes ----
      const customFixers = agentsSettings.customAgents.filter(
        (a) => a.enabled && a.role === "fixer",
      );
      for (const ca of customFixers) {
        if (controller.signal.aborted) break;
        setStatusLine(`Agent custom « ${ca.name} » vérifie la correction…`);
        const caHistory: Msg[] = [
          { role: "assistant", content: lastAssistantText },
          {
            role: "user",
            content:
              `Errors that were observed:\n${errorBlock}\n\n` +
              `<context>\n${buildContext(getLatestFiles())}\n</context>\n\n` +
              `Review the fix above. If anything is still wrong or could be improved, re-emit corrected file(s) with <lov-write>. If the fix is good, just say so briefly.`,
          },
        ];
        const caResult = await runAgentTurn(
          "fixer",
          caHistory,
          controller.signal,
          ca.systemPrompt,
          `${ca.emoji} ${ca.name}`,
        );
        if (!caResult) break;
        const caFailures = applyActions(caResult.actions, allowDelete);
        if (caFailures.length > 0) break;
        if (caResult.actions.length > 0) onSwitchToPreview?.();
        lastAssistantText = caResult.text;
      }

      clearRuntimeErrors();
    }
    return true;
  };

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const visibleUserMsg: Msg = { role: "user", content: trimmed };
    const baseHistory: Msg[] = [...messages, visibleUserMsg];
    setMessages(baseHistory);
    setInput("");
    setLoading(true);

    // Notify the Runner panel that an agent cycle just started
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("lovable:agent-start", { detail: { label: "Agent démarre…" } }),
      );
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const agentsSettings = loadAgentsSettings();
      const aiSettings = loadAISettings();
      const currentFilesNow = getLatestFiles();
      const topIntent = detectIntent(trimmed, currentFilesNow.length > 0);

      // -------- Native tool-calling mode (agents = same caps as Lovable IDE) --------
      if (agentsSettings.useNativeTools && supportsReliableNativeTools(aiSettings.provider)) {
        await runAgentToolLoop(trimmed, controller);
        setStatusLine("");
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("lovable:agent-done"));
        }
        return;
      }

      // ---------- Optional planning phase for big CREATION prompts only ----------
      // Don't plan a targeted modification — that's what makes the agent
      // rewrite the whole project step by step.
      let plan: PlanStep[] | null = null;
      if (
        topIntent === "create" &&
        agentsSettings.planner.enabled &&
        shouldPlan(trimmed, agentsSettings.plannerMinChars)
      ) {
        setStatusLine("Planner agent is breaking your request into steps…");
        const plannerHistory: Msg[] = [
          {
            role: "user",
            content: `User request:\n"""${trimmed}"""\n\nProject currently has these files:\n${
              files.length === 0 ? "(empty)" : files.map((f) => f.name).join(", ")
            }\n\nReturn the plan now as JSON only.`,
          },
        ];
        const plannerResult = await runAgentTurn("planner", plannerHistory, controller.signal);
        if (plannerResult) {
          plan = extractPlan(plannerResult.text);
        }
      }

      if (plan && plan.length > 1) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content:
              `📋 **Plan en ${plan!.length} étapes :**\n\n` +
              plan!.map((s, i) => `${i + 1}. **${s.title}** — ${s.instruction}`).join("\n"),
          },
        ]);

        for (let i = 0; i < plan.length; i++) {
          if (controller.signal.aborted) break;
          const step = plan[i];
          setStatusLine(`Étape ${i + 1}/${plan.length} : ${step.title}…`);
          const ok = await runBuildCycle(
            step.instruction,
            messages,
            controller,
            `(Original user goal: ${trimmed})\n\nStep ${i + 1}/${plan.length} — ${step.title}`,
          );
          if (!ok) break;
        }
      } else {
        // Simple single-shot prompt
        setStatusLine("Builder agent is thinking…");
        await runBuildCycle(trimmed, messages, controller);
      }

      setStatusLine("");
      // Notify the runner panel that the agent finished a cycle so it can auto-restart.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("lovable:agent-done"));
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `⚠️ ${(err as Error).message}` },
        ]);
      }
    } finally {
      setLoading(false);
      setStatusLine("");
      abortRef.current = null;
    }
  };

  // Keep the latest send() reachable from event listeners (Fix-from-runner button).
  sendRef.current = send;

  return (
    <div className="flex h-full flex-col bg-[var(--panel-bg)]">
      <div className="flex items-center justify-between border-b border-border bg-[var(--sidebar-bg)] px-3 py-1.5">
        <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 text-primary" /> AI Agent
          <span className="ml-1 hidden items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary sm:inline-flex">
            <Wand2 className="h-2.5 w-2.5" /> multi-agent
          </span>
        </span>
        <div className="flex items-center gap-2">
          {loading && (
            <button
              onClick={() => abortRef.current?.abort()}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Stop
            </button>
          )}
          {onOpenSettings && (
            <button
              onClick={onOpenSettings}
              title="AI settings"
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <SettingsIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-auto p-3">
        {messages.length === 0 && (
          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
              <p className="mb-2 flex items-center gap-2 text-foreground">
                <Bot className="h-4 w-4 text-primary" /> Hi! I'm your multi-agent coding system.
              </p>
              I'll <strong>build</strong> the project, <strong>run it</strong> in the preview,
              and a <strong>fixer agent</strong> will automatically repair any runtime errors.
              Customize each agent in the <strong>Agents</strong> menu (top bar).
            </div>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground hover:border-primary hover:text-foreground"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <ChatMessage key={i} message={m} />
        ))}
        {loading && statusLine && (
          <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-2 py-1.5 text-xs text-primary">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {statusLine}
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="border-t border-border bg-[var(--sidebar-bg)] p-2"
      >
        <div className="flex items-end gap-2 rounded-md border border-border bg-input p-2 focus-within:border-primary">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder="Ask the agent to build something…"
            rows={1}
            className="max-h-32 flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="rounded-md bg-primary p-1.5 text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </form>
    </div>
  );
}

function ChatMessage({ message }: { message: Msg }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end gap-2 text-sm">
        <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-primary-foreground">
          <span className="whitespace-pre-wrap">{message.content}</span>
        </div>
        <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <User2 className="h-3.5 w-3.5" />
        </div>
      </div>
    );
  }

  const { text, actions } = parseAgentOutput(message.content || "");
  const isFixer = message.agentRole === "fixer";
  return (
    <div className="flex justify-start gap-2 text-sm">
      <div
        className={cn(
          "mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
          isFixer ? "bg-amber-500/15 text-amber-500" : "bg-primary/15 text-primary",
        )}
      >
        {isFixer ? <ShieldCheck className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
      </div>
      <div className="max-w-[85%] space-y-2 rounded-lg bg-card px-3 py-2 text-foreground">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {isFixer ? "Fixer agent" : "Builder agent"}
        </div>
        <div className="prose prose-invert prose-sm max-w-none prose-pre:my-2 prose-pre:bg-[var(--terminal-bg)] prose-code:text-primary">
          <ReactMarkdown>{text || "…"}</ReactMarkdown>
        </div>
        {message.toolEvents && message.toolEvents.length > 0 && (
          <div className="rounded-md border border-primary/30 bg-primary/5 p-2 text-[11px]">
            <div className="mb-1 flex items-center gap-1 font-medium text-primary">
              <Wrench className="h-3 w-3" /> {message.toolEvents.length} action{message.toolEvents.length > 1 ? "s" : ""} agent
            </div>
            <ul className="space-y-0.5 text-muted-foreground">
              {message.toolEvents.map((ev, i) => (
                <li key={i} className={ev.ok ? "" : "text-red-400"}>
                  {ev.ok ? "✓" : "✗"} {ev.label}
                </li>
              ))}
            </ul>
          </div>
        )}
        {actions.length > 0 && (
          <div
            className={cn(
              "rounded-md border p-2 text-[11px]",
              isFixer
                ? "border-amber-500/30 bg-amber-500/5"
                : "border-primary/30 bg-primary/5",
            )}
          >
            <div
              className={cn(
                "mb-1 flex items-center gap-1 font-medium",
                isFixer ? "text-amber-500" : "text-primary",
              )}
            >
              {isFixer ? <ShieldCheck className="h-3 w-3" /> : <Wand2 className="h-3 w-3" />}
              Applied {actions.length} change{actions.length > 1 ? "s" : ""}
            </div>
            <ul className="space-y-0.5 text-muted-foreground">
              {actions.map((a, idx) => (
                <li key={idx}>
                  {a.type === "write" && (
                    <>
                      📝 <code>{a.path}</code>
                    </>
                  )}
                  {a.type === "rename" && (
                    <>
                      ✏️ <code>{a.from}</code> → <code>{a.to}</code>
                    </>
                  )}
                  {a.type === "delete" && (
                    <>
                      🗑️ <code>{a.path}</code>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
