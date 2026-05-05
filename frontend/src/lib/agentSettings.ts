export type AgentRole = "builder" | "fixer" | "planner";

export type AgentConfig = {
  enabled: boolean;
  /** Custom system prompt override. Empty string = use server default. */
  systemPrompt: string;
};

/** A user-defined extra agent. Runs as an additional refinement pass. */
export type CustomAgent = {
  id: string;
  name: string;
  emoji: string;
  description: string;
  /** Which built-in role's behaviour it mimics (which point of the pipeline it hooks into). */
  role: AgentRole;
  enabled: boolean;
  systemPrompt: string;
};

export type AgentsSettings = {
  builder: AgentConfig;
  fixer: AgentConfig;
  planner: AgentConfig;
  /** Max repair passes performed by the fixer. */
  maxFixIterations: number;
  /** Min prompt length (chars) to trigger the planner. */
  plannerMinChars: number;
  /** User-created custom agents. */
  customAgents: CustomAgent[];
  /**
   * Native tool calling: when true, agents use OpenAI-style function calls
   * (read_file, write_file, exec_shell, web_search…) and can run multi-step
   * autonomous loops just like the IDE meta-agent. When false, fall back to
   * the legacy <lov-write> XML tag pipeline.
   */
  useNativeTools: boolean;
  /** Hard cap on tool-call iterations per user message (safety net). */
  maxToolIterations: number;
};

const STORAGE_KEY = "lovable-ide:agents-settings";

export const DEFAULT_BUILDER_PROMPT = `You are the BUILDER agent of an autonomous multi-agent system inside Lovable IDE.
Your job: design and write working client-side projects from the user's request.
- Output ONLY browser code (HTML/CSS/vanilla JS), no Node.
- Use <lov-write path="..."> for full-file writes, <lov-rename from to> and <lov-delete path> for file ops.
- Always emit COMPLETE files. Keep filenames at project root.
- When files already exist in <context>, ADD or PATCH only what's needed; do not recreate from scratch.`;

export const DEFAULT_FIXER_PROMPT = `You are the FIXER agent of an autonomous multi-agent system inside Lovable IDE.
The previous code produced runtime errors in the browser preview.
- Read the errors in the user message and fix the ROOT cause.
- Re-emit only the file(s) that need changes, in full, using <lov-write>.
- Do not apologize or restate the prompt. Briefly explain the fix in 1-2 sentences.`;

export const DEFAULT_PLANNER_PROMPT = `You are the PLANNER agent of an autonomous multi-agent system inside Lovable IDE.
Split a long/complex user request into 2-6 SMALL ordered build steps for the BUILDER.
- Output ONLY JSON: { "steps": [ { "title": "...", "instruction": "..." } ] }
- Step 1 is always the base structure (HTML+CSS+JS skeleton).
- Each next step adds ONE feature on top. Max 6 steps. No prose, no markdown fences.`;

/** Pre-configured "Lovable-style" agents seeded by default. */
export const PRESET_CUSTOM_AGENTS: CustomAgent[] = [
  {
    id: "preset-patcher",
    name: "Patcher",
    emoji: "🩹",
    description:
      "Garantit que les demandes de modification ne réécrivent PAS tout le projet : ne touche qu'aux fichiers nécessaires.",
    role: "builder",
    enabled: true,
    systemPrompt: `You are the PATCHER agent inside Lovable IDE.
The Builder may have over-rewritten the project. Your job: ENFORCE minimal edits.

Hard rules:
- Look at <context>: which files were ACTUALLY needed to fulfill the user request?
- If the Builder re-emitted files that did NOT need to change, that is a bug. DO NOT re-emit them yourself either — the previous version on disk is canonical.
- If the Builder MISSED a file that needed a small touch (e.g. wiring a new button to an existing handler), re-emit ONLY that file with <lov-write>.
- If the Builder's output is already minimal and correct, just say "Patch OK" and emit nothing.
- NEVER use <lov-delete> unless the user explicitly asked to delete that file.
- Preserve all existing variable names, IDs, classes, exported APIs.
- Always output COMPLETE files when you do write.`,
  },
  {
    id: "preset-designer",
    name: "Designer",
    emoji: "🎨",
    description: "Améliore le visuel : couleurs, typographie, espacement, hiérarchie.",
    role: "builder",
    enabled: false,
    systemPrompt: `You are the DESIGNER agent inside Lovable IDE.
The Builder just produced a working project. Your job: make it BEAUTIFUL.
- Improve visual hierarchy, typography, spacing, colors and contrast.
- Add subtle hover states, transitions, and a coherent color palette.
- Prefer modern, minimal, Apple/Linear-inspired aesthetics unless the user asked for something else.
- Re-emit ONLY the file(s) you change (usually style.css and sometimes index.html) using <lov-write> with COMPLETE content.
- Do NOT change behaviour or remove features. Do NOT add Node/build steps.
- If the design is already great, briefly say "RAS" and emit nothing.`,
  },
  {
    id: "preset-refactorer",
    name: "Refactorer",
    emoji: "🧹",
    description: "Nettoie le code : nommage, fonctions trop longues, duplication.",
    role: "builder",
    enabled: false,
    systemPrompt: `You are the REFACTORER agent inside Lovable IDE.
Read the project produced by the Builder and improve code quality WITHOUT changing behaviour.
- Split functions > 40 lines, give clearer names, remove dead code and duplication.
- Keep the public API of each file identical (same global functions, same DOM ids/classes used).
- Re-emit changed files in full with <lov-write>. Keep filenames at root.
- If the code is already clean, output a one-line "RAS" and emit no files.`,
  },
  {
    id: "preset-a11y",
    name: "Accessibilité",
    emoji: "♿",
    description: "Vérifie alt, labels, contraste, rôles ARIA, navigation clavier.",
    role: "fixer",
    enabled: true,
    systemPrompt: `You are the ACCESSIBILITY (a11y) agent inside Lovable IDE.
Audit the current HTML/CSS for accessibility problems and fix them:
- Missing alt on <img>, missing <label> on form fields, missing button text.
- Insufficient color contrast, missing :focus styles, missing aria-* where needed.
- Improper heading order (h1 → h2 → h3).
Re-emit only the file(s) that need fixes with <lov-write>. If nothing to fix, say "A11y OK".`,
  },
  {
    id: "preset-debugger",
    name: "Debugger",
    emoji: "🐛",
    description: "Analyse les erreurs runtime en profondeur et propose un correctif robuste.",
    role: "fixer",
    enabled: true,
    systemPrompt: `You are the DEBUGGER agent inside Lovable IDE.
A previous Fixer pass already attempted to repair runtime errors. Your job is a deeper review:
- Re-read the errors and the current files in <context>.
- Look for ROOT-cause issues: race conditions, missing null checks, wrong selectors, event listeners attached too early, etc.
- If you find a real remaining bug, re-emit the corrected file(s) with <lov-write>.
- Otherwise, briefly explain why the current code is correct and emit no files.`,
  },
  {
    id: "preset-seo",
    name: "SEO",
    emoji: "🔍",
    description: "Améliore <title>, meta description, balises sémantiques et og:tags.",
    role: "builder",
    enabled: false,
    systemPrompt: `You are the SEO agent inside Lovable IDE.
Improve discoverability of the project's index.html:
- Make sure <title> is unique, < 60 chars, and contains the key topic.
- Add a relevant <meta name="description"> (< 160 chars).
- Add Open Graph tags (og:title, og:description, og:type=website).
- Use semantic HTML (header/main/section/article/footer) and a single <h1>.
Re-emit index.html with <lov-write> if any change is needed. Don't touch JS or CSS unless required.`,
  },
  {
    id: "preset-perf",
    name: "Performance",
    emoji: "⚡",
    description: "Détecte les boucles inutiles, gros DOM, listeners en double, images lourdes.",
    role: "builder",
    enabled: false,
    systemPrompt: `You are the PERFORMANCE agent inside Lovable IDE.
Look for obvious performance problems in the current project:
- Event listeners added in loops or re-attached on every render.
- Heavy DOM operations inside a hot loop (use DocumentFragment, batch updates).
- Repeated querySelector calls that could be cached.
- Inline images that should use loading="lazy".
Re-emit only the file(s) you change with <lov-write>. If nothing to optimize, say "Perf OK".`,
  },
];

export const DEFAULT_AGENTS_SETTINGS: AgentsSettings = {
  builder: { enabled: true, systemPrompt: "" },
  fixer: { enabled: true, systemPrompt: "" },
  planner: { enabled: true, systemPrompt: "" },
  maxFixIterations: 5,
  plannerMinChars: 280,
  customAgents: PRESET_CUSTOM_AGENTS,
  useNativeTools: true,
  maxToolIterations: 24,
};

export function loadAgentsSettings(): AgentsSettings {
  if (typeof window === "undefined") return DEFAULT_AGENTS_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_AGENTS_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AgentsSettings>;
    const savedCustoms = Array.isArray(parsed.customAgents) ? parsed.customAgents : [];
    // Merge in any preset the user doesn't have yet (matched by id), without
    // overwriting their edits/toggles for presets they already have.
    const existingIds = new Set(savedCustoms.map((a) => a.id));
    const mergedCustoms = [
      ...savedCustoms,
      ...PRESET_CUSTOM_AGENTS.filter((p) => !existingIds.has(p.id)),
    ];
    return {
      ...DEFAULT_AGENTS_SETTINGS,
      ...parsed,
      builder: { ...DEFAULT_AGENTS_SETTINGS.builder, ...(parsed.builder ?? {}) },
      fixer: { ...DEFAULT_AGENTS_SETTINGS.fixer, ...(parsed.fixer ?? {}) },
      planner: { ...DEFAULT_AGENTS_SETTINGS.planner, ...(parsed.planner ?? {}) },
      customAgents: mergedCustoms,
    };
  } catch {
    return DEFAULT_AGENTS_SETTINGS;
  }
}

export function saveAgentsSettings(s: AgentsSettings) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

export function makeCustomAgent(partial?: Partial<CustomAgent>): CustomAgent {
  return {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "Nouvel agent",
    emoji: "🤖",
    description: "Décris ici le rôle de cet agent.",
    role: "builder",
    enabled: true,
    systemPrompt: "",
    ...partial,
  };
}

export const AGENT_META: Record<
  AgentRole,
  { name: string; emoji: string; description: string; defaultPrompt: string }
> = {
  builder: {
    name: "Builder",
    emoji: "🏗️",
    description: "Génère le code des fichiers à partir de ta demande.",
    defaultPrompt: DEFAULT_BUILDER_PROMPT,
  },
  fixer: {
    name: "Fixer",
    emoji: "🔧",
    description:
      "Corrige automatiquement les erreurs runtime détectées dans la preview.",
    defaultPrompt: DEFAULT_FIXER_PROMPT,
  },
  planner: {
    name: "Planner",
    emoji: "📋",
    description:
      "Découpe les gros prompts en 2 à 6 étapes que le Builder exécute une par une.",
    defaultPrompt: DEFAULT_PLANNER_PROMPT,
  },
};

export const ROLE_LABEL: Record<AgentRole, string> = {
  builder: "🏗️ Passe builder (refine après le Builder)",
  fixer: "🔧 Passe fixer (renforce la correction d'erreurs)",
  planner: "📋 Pré-planification (en plus du Planner)",
};
