import { useEffect, useState } from "react";
import {
  X,
  RotateCcw,
  Save,
  Bot,
  ShieldCheck,
  ListOrdered,
  Plus,
  Trash2,
  Sparkles,
} from "lucide-react";
import {
  AGENT_META,
  DEFAULT_AGENTS_SETTINGS,
  ROLE_LABEL,
  loadAgentsSettings,
  makeCustomAgent,
  saveAgentsSettings,
  type AgentRole,
  type AgentsSettings,
  type CustomAgent,
} from "@/lib/agentSettings";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onClose: () => void;
}

const ROLE_ICON: Record<AgentRole, React.ReactNode> = {
  builder: <Bot className="h-4 w-4" />,
  fixer: <ShieldCheck className="h-4 w-4" />,
  planner: <ListOrdered className="h-4 w-4" />,
};

/** Selection in the sidebar: a built-in role OR a custom agent id. */
type Selection = { kind: "builtin"; role: AgentRole } | { kind: "custom"; id: string };

export function AgentsDialog({ open, onClose }: Props) {
  const [settings, setSettings] = useState<AgentsSettings>(DEFAULT_AGENTS_SETTINGS);
  const [active, setActive] = useState<Selection>({ kind: "builtin", role: "builder" });
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (open) {
      setSettings(loadAgentsSettings());
      setDirty(false);
      setActive({ kind: "builtin", role: "builder" });
    }
  }, [open]);

  if (!open) return null;

  const updateBuiltin = (role: AgentRole, patch: Partial<AgentsSettings["builder"]>) => {
    setSettings((s) => ({ ...s, [role]: { ...s[role], ...patch } }));
    setDirty(true);
  };

  const updateCustom = (id: string, patch: Partial<CustomAgent>) => {
    setSettings((s) => ({
      ...s,
      customAgents: s.customAgents.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    }));
    setDirty(true);
  };

  const addCustom = () => {
    const newAgent = makeCustomAgent();
    setSettings((s) => ({ ...s, customAgents: [...s.customAgents, newAgent] }));
    setActive({ kind: "custom", id: newAgent.id });
    setDirty(true);
  };

  const deleteCustom = (id: string) => {
    setSettings((s) => ({
      ...s,
      customAgents: s.customAgents.filter((a) => a.id !== id),
    }));
    setActive({ kind: "builtin", role: "builder" });
    setDirty(true);
  };

  const handleSave = () => {
    saveAgentsSettings(settings);
    setDirty(false);
    onClose();
  };

  const handleResetAll = () => {
    setSettings(DEFAULT_AGENTS_SETTINGS);
    setActive({ kind: "builtin", role: "builder" });
    setDirty(true);
  };

  // Resolve currently selected agent
  const builtinSelected = active.kind === "builtin";
  const builtinMeta = builtinSelected ? AGENT_META[active.role] : null;
  const builtinCfg = builtinSelected ? settings[active.role] : null;
  const customSelected =
    active.kind === "custom"
      ? settings.customAgents.find((a) => a.id === active.id) ?? null
      : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">Gestion des agents</h2>
            <p className="text-xs text-muted-foreground">
              Active, désactive, personnalise ou crée tes propres agents.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Sidebar list */}
          <aside className="w-60 shrink-0 overflow-auto border-r border-border bg-[var(--sidebar-bg)] p-2">
            <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Agents système
            </div>
            <div className="space-y-1">
              {(Object.keys(AGENT_META) as AgentRole[]).map((role) => {
                const m = AGENT_META[role];
                const c = settings[role];
                const isActive = active.kind === "builtin" && active.role === role;
                return (
                  <button
                    key={role}
                    onClick={() => setActive({ kind: "builtin", role })}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm transition",
                      isActive
                        ? "bg-primary/15 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <span className="text-base leading-none">{m.emoji}</span>
                    <span className="flex-1">
                      <span className="block font-medium">{m.name}</span>
                      <span className="block text-[10px] text-muted-foreground">
                        {c.enabled ? "Activé" : "Désactivé"}
                        {c.systemPrompt ? " · custom" : ""}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full",
                        c.enabled ? "bg-primary" : "bg-muted-foreground/40",
                      )}
                    />
                  </button>
                );
              })}
            </div>

            <div className="mt-4 flex items-center justify-between px-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Tes agents ({settings.customAgents.length})
              </div>
              <button
                onClick={addCustom}
                title="Créer un nouvel agent"
                className="flex items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/25"
              >
                <Plus className="h-3 w-3" /> Nouveau
              </button>
            </div>
            <div className="mt-1 space-y-1">
              {settings.customAgents.length === 0 && (
                <p className="px-2 py-2 text-[11px] text-muted-foreground">
                  Aucun agent perso. Clique sur <em>Nouveau</em> pour en créer un.
                </p>
              )}
              {settings.customAgents.map((a) => {
                const isActive = active.kind === "custom" && active.id === a.id;
                return (
                  <button
                    key={a.id}
                    onClick={() => setActive({ kind: "custom", id: a.id })}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm transition",
                      isActive
                        ? "bg-primary/15 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <span className="text-base leading-none">{a.emoji}</span>
                    <span className="flex-1 truncate">
                      <span className="block truncate font-medium">{a.name}</span>
                      <span className="block text-[10px] text-muted-foreground">
                        {a.role} · {a.enabled ? "activé" : "désactivé"}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full",
                        a.enabled ? "bg-primary" : "bg-muted-foreground/40",
                      )}
                    />
                  </button>
                );
              })}
            </div>

            <div className="mt-4 border-t border-border pt-3">
              <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Réglages globaux
              </div>
              <label className="block px-2 text-xs text-muted-foreground">
                Max passes du Fixer
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={settings.maxFixIterations}
                  onChange={(e) => {
                    setSettings((s) => ({
                      ...s,
                      maxFixIterations: Math.max(
                        0,
                        Math.min(10, Number(e.target.value) || 0),
                      ),
                    }));
                    setDirty(true);
                  }}
                  className="mt-1 w-full rounded border border-border bg-input px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
                />
              </label>
              <label className="mt-2 block px-2 text-xs text-muted-foreground">
                Seuil Planner (caractères)
                <input
                  type="number"
                  min={50}
                  max={4000}
                  value={settings.plannerMinChars}
                  onChange={(e) => {
                    setSettings((s) => ({
                      ...s,
                      plannerMinChars: Math.max(
                        50,
                        Math.min(4000, Number(e.target.value) || 0),
                      ),
                    }));
                    setDirty(true);
                  }}
                  className="mt-1 w-full rounded border border-border bg-input px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
                />
              </label>

              {/* Tool-calling toggle */}
              <div className="mt-3 rounded-md border border-border bg-muted/30 p-2">
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    checked={settings.useNativeTools}
                    onChange={(e) => {
                      setSettings((s) => ({ ...s, useNativeTools: e.target.checked }));
                      setDirty(true);
                    }}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                  />
                  <span className="flex-1">
                    <span className="block text-xs font-medium text-foreground">
                      Mode tool-calling 🛠️
                    </span>
                    <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
                      Les agents utilisent des outils (read/write/exec/web) en
                      boucle autonome, comme l'agent IDE. Désactive pour revenir
                      au pipeline {`<lov-write>`} classique.
                    </span>
                  </span>
                </label>
              </div>

              <label className="mt-2 block px-2 text-xs text-muted-foreground">
                Max itérations d'outils
                <input
                  type="number"
                  min={1}
                  max={50}
                  disabled={!settings.useNativeTools}
                  value={settings.maxToolIterations}
                  onChange={(e) => {
                    setSettings((s) => ({
                      ...s,
                      maxToolIterations: Math.max(
                        1,
                        Math.min(50, Number(e.target.value) || 1),
                      ),
                    }));
                    setDirty(true);
                  }}
                  className="mt-1 w-full rounded border border-border bg-input px-2 py-1 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50"
                />
              </label>
            </div>
          </aside>

          {/* Detail panel */}
          <div className="flex min-w-0 flex-1 flex-col overflow-auto p-4">
            {builtinSelected && builtinMeta && builtinCfg && (
              <BuiltinPanel
                role={(active as { kind: "builtin"; role: AgentRole }).role}
                meta={builtinMeta}
                cfg={builtinCfg}
                onChange={(patch) =>
                  updateBuiltin(
                    (active as { kind: "builtin"; role: AgentRole }).role,
                    patch,
                  )
                }
              />
            )}
            {!builtinSelected && customSelected && (
              <CustomPanel
                agent={customSelected}
                onChange={(patch) => updateCustom(customSelected.id, patch)}
                onDelete={() => deleteCustom(customSelected.id)}
              />
            )}
            {!builtinSelected && !customSelected && (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                Sélectionne un agent à gauche.
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-4 py-3">
          <button
            onClick={handleResetAll}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Tout réinitialiser
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              Annuler
            </button>
            <button
              onClick={handleSave}
              disabled={!dirty}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              <Save className="h-3 w-3" /> Enregistrer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------- Built-in agent editor ----------------

function BuiltinPanel({
  role,
  meta,
  cfg,
  onChange,
}: {
  role: AgentRole;
  meta: (typeof AGENT_META)[AgentRole];
  cfg: { enabled: boolean; systemPrompt: string };
  onChange: (patch: Partial<{ enabled: boolean; systemPrompt: string }>) => void;
}) {
  return (
    <>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-primary">
              {ROLE_ICON[role]}
            </span>
            {meta.emoji} {meta.name}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">{meta.description}</p>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <span>{cfg.enabled ? "Activé" : "Désactivé"}</span>
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
            className="h-4 w-4 accent-primary"
          />
        </label>
      </div>

      {!cfg.enabled && role !== "planner" && (
        <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          ⚠️ Désactiver le {meta.name} cassera la chaîne (le pipeline ne pourra pas
          {role === "builder" ? " écrire de fichiers" : " corriger les erreurs"}).
        </div>
      )}
      {!cfg.enabled && role === "planner" && (
        <div className="mb-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Le Planner désactivé : tous les prompts iront directement au Builder en un seul
          passage.
        </div>
      )}

      <div className="mb-1 flex items-center justify-between">
        <label className="text-xs font-medium text-foreground">
          System prompt personnalisé
        </label>
        <button
          onClick={() => onChange({ systemPrompt: "" })}
          disabled={!cfg.systemPrompt}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          <RotateCcw className="h-3 w-3" /> Réinitialiser
        </button>
      </div>
      <p className="mb-2 text-[11px] text-muted-foreground">
        Laisse vide pour utiliser le prompt par défaut. Sinon ton texte remplace
        entièrement les instructions de cet agent.
      </p>
      <textarea
        value={cfg.systemPrompt}
        onChange={(e) => onChange({ systemPrompt: e.target.value })}
        placeholder={meta.defaultPrompt}
        rows={14}
        className="flex-1 resize-none rounded border border-border bg-input p-3 font-mono text-xs text-foreground outline-none focus:border-primary"
      />

      <details className="mt-3 rounded border border-border bg-muted/30 p-2 text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
          Voir le prompt par défaut
        </summary>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">
          {meta.defaultPrompt}
        </pre>
      </details>
    </>
  );
}

// ---------------- Custom agent editor ----------------

function CustomPanel({
  agent,
  onChange,
  onDelete,
}: {
  agent: CustomAgent;
  onChange: (patch: Partial<CustomAgent>) => void;
  onDelete: () => void;
}) {
  return (
    <>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/15 text-lg">
            {agent.emoji || "🤖"}
          </span>
          <div>
            <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
              <Sparkles className="h-4 w-4 text-primary" /> Agent personnalisé
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Cet agent est ajouté à ton pipeline en plus des agents système.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <span>{agent.enabled ? "Activé" : "Désactivé"}</span>
            <input
              type="checkbox"
              checked={agent.enabled}
              onChange={(e) => onChange({ enabled: e.target.checked })}
              className="h-4 w-4 accent-primary"
            />
          </label>
          <button
            onClick={onDelete}
            title="Supprimer cet agent"
            className="rounded p-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="mb-3 grid grid-cols-[80px_1fr] gap-3">
        <label className="text-xs text-muted-foreground">
          Emoji
          <input
            value={agent.emoji}
            onChange={(e) => onChange({ emoji: e.target.value.slice(0, 4) })}
            maxLength={4}
            className="mt-1 w-full rounded border border-border bg-input px-2 py-1.5 text-center text-lg outline-none focus:border-primary"
          />
        </label>
        <label className="text-xs text-muted-foreground">
          Nom
          <input
            value={agent.name}
            onChange={(e) => onChange({ name: e.target.value })}
            className="mt-1 w-full rounded border border-border bg-input px-2 py-1.5 text-sm text-foreground outline-none focus:border-primary"
          />
        </label>
      </div>

      <label className="mb-3 block text-xs text-muted-foreground">
        Description courte
        <input
          value={agent.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="Ex: vérifie l'accessibilité du HTML produit"
          className="mt-1 w-full rounded border border-border bg-input px-2 py-1.5 text-sm text-foreground outline-none focus:border-primary"
        />
      </label>

      <label className="mb-3 block text-xs text-muted-foreground">
        Rôle dans le pipeline
        <select
          value={agent.role}
          onChange={(e) => onChange({ role: e.target.value as AgentRole })}
          className="mt-1 w-full rounded border border-border bg-input px-2 py-1.5 text-sm text-foreground outline-none focus:border-primary"
        >
          {(Object.keys(ROLE_LABEL) as AgentRole[]).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-[11px] text-muted-foreground">
          {agent.role === "builder" &&
            "S'exécute juste après le Builder pour affiner / étendre le code."}
          {agent.role === "fixer" &&
            "S'exécute après chaque passe du Fixer pour renforcer la correction."}
          {agent.role === "planner" &&
            "Joue un rôle de planification additionnel (note: utilise plutôt le Planner système pour découper)."}
        </span>
      </label>

      <label className="mb-1 block text-xs font-medium text-foreground">
        System prompt
      </label>
      <p className="mb-2 text-[11px] text-muted-foreground">
        Donne à ton agent ses instructions complètes. Il peut utiliser{" "}
        <code className="rounded bg-muted px-1">&lt;lov-write&gt;</code>,{" "}
        <code className="rounded bg-muted px-1">&lt;lov-rename&gt;</code> et{" "}
        <code className="rounded bg-muted px-1">&lt;lov-delete&gt;</code> pour modifier les
        fichiers.
      </p>
      <textarea
        value={agent.systemPrompt}
        onChange={(e) => onChange({ systemPrompt: e.target.value })}
        placeholder={`Exemple :\nTu es un agent QA. Vérifie le HTML produit par le Builder. Si tu trouves des problèmes d'accessibilité (alt manquants, contraste, labels), corrige-les en réémettant les fichiers concernés avec <lov-write>. Sinon, écris simplement "RAS".`}
        rows={12}
        className="flex-1 resize-none rounded border border-border bg-input p-3 font-mono text-xs text-foreground outline-none focus:border-primary"
      />
    </>
  );
}
