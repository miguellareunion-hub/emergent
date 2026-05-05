import { useEffect, useState } from "react";
import { Eye, EyeOff, X, KeyRound, Sparkles, ExternalLink, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import {
  type AISettings,
  type AIProvider,
  DEFAULT_SETTINGS,
  LOVABLE_MODELS,
  OPENAI_MODELS,
  loadAISettings,
  saveAISettings,
} from "@/lib/aiSettings";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: (s: AISettings) => void;
}

export function SettingsDialog({ open, onClose, onSaved }: Props) {
  const [settings, setSettings] = useState<AISettings>(DEFAULT_SETTINGS);
  const [showKey, setShowKey] = useState(false);
  const [showLmKey, setShowLmKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    { ok: boolean; message: string } | null
  >(null);

  useEffect(() => {
    if (open) {
      setSettings(loadAISettings());
      setTestResult(null);
    }
  }, [open]);

  if (!open) return null;

  const update = <K extends keyof AISettings>(k: K, v: AISettings[K]) =>
    setSettings((s) => ({ ...s, [k]: v }));

  const handleSave = () => {
    saveAISettings(settings);
    onSaved?.(settings);
    onClose();
  };

  const handleTestLmStudio = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const base = settings.lmstudioBaseUrl.trim().replace(/\/$/, "");
      const url = `${base}/models`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (settings.lmstudioApiKey.trim()) {
        headers["Authorization"] = `Bearer ${settings.lmstudioApiKey.trim()}`;
      }
      const res = await fetch(url, { method: "GET", headers });
      if (!res.ok) {
        setTestResult({
          ok: false,
          message: `HTTP ${res.status} — ${res.statusText || "échec"}`,
        });
        return;
      }
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      const ids = data?.data?.map((m) => m.id) ?? [];
      const found = ids.includes(settings.lmstudioModel.trim());
      setTestResult({
        ok: true,
        message: found
          ? `Connexion OK — modèle « ${settings.lmstudioModel} » trouvé.`
          : `Connexion OK, mais le modèle « ${settings.lmstudioModel} » n'apparaît pas. Modèles dispo: ${ids.slice(0, 3).join(", ") || "aucun"}${ids.length > 3 ? "…" : ""}`,
      });
    } catch (err) {
      setTestResult({
        ok: false,
        message:
          err instanceof Error
            ? `Échec: ${err.message} (CORS ou serveur arrêté ?)`
            : "Échec inconnu",
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-lg border border-border bg-card text-foreground shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-primary" /> AI Agent Settings
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 p-4">
          {/* Provider */}
          <div>
            <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Provider
            </label>
            <div className="grid grid-cols-3 gap-2">
              <ProviderCard
                active={settings.provider === "lovable"}
                onClick={() => update("provider", "lovable" as AIProvider)}
                title="Lovable AI"
                desc="Gateway préconfiguré. Crédits gratuits inclus."
              />
              <ProviderCard
                active={settings.provider === "openai"}
                onClick={() => update("provider", "openai" as AIProvider)}
                title="OpenAI"
                desc="Utilise ta propre clé API OpenAI."
              />
              <ProviderCard
                active={settings.provider === "lmstudio"}
                onClick={() => update("provider", "lmstudio" as AIProvider)}
                title="LM Studio"
                desc="Modèle local sur ta machine."
              />
            </div>
          </div>

          {/* OpenAI config */}
          {settings.provider === "openai" && (
            <div className="space-y-3 rounded-md border border-border bg-[var(--sidebar-bg)] p-3">
              <div>
                <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <KeyRound className="h-3.5 w-3.5" /> OpenAI API Key
                </label>
                <div className="flex items-center gap-2 rounded-md border border-border bg-input px-2 focus-within:border-primary">
                  <input
                    type={showKey ? "text" : "password"}
                    value={settings.openaiApiKey}
                    onChange={(e) => update("openaiApiKey", e.target.value)}
                    placeholder="sk-..."
                    className="flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {showKey ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                  Stored locally in your browser. Get a key at{" "}
                  <a
                    href="https://platform.openai.com/api-keys"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-primary hover:underline"
                  >
                    platform.openai.com <ExternalLink className="h-3 w-3" />
                  </a>
                </p>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-foreground">
                  Model
                </label>
                <select
                  value={settings.openaiModel}
                  onChange={(e) => update("openaiModel", e.target.value)}
                  className="w-full rounded-md border border-border bg-input px-2 py-2 text-sm outline-none focus:border-primary"
                >
                  {OPENAI_MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Lovable config */}
          {settings.provider === "lovable" && (
            <div className="space-y-3 rounded-md border border-border bg-[var(--sidebar-bg)] p-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-foreground">
                  Model
                </label>
                <select
                  value={settings.lovableModel}
                  onChange={(e) => update("lovableModel", e.target.value)}
                  className="w-full rounded-md border border-border bg-input px-2 py-2 text-sm outline-none focus:border-primary"
                >
                  {LOVABLE_MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Uses the built-in Lovable AI Gateway. No API key required.
                </p>
              </div>
            </div>
          )}

          {/* LM Studio config */}
          {settings.provider === "lmstudio" && (
            <div className="space-y-3 rounded-md border border-border bg-[var(--sidebar-bg)] p-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-foreground">
                  URL du serveur LM Studio
                </label>
                <input
                  type="text"
                  value={settings.lmstudioBaseUrl}
                  onChange={(e) => update("lmstudioBaseUrl", e.target.value)}
                  placeholder="http://localhost:1234/v1"
                  className="w-full rounded-md border border-border bg-input px-2 py-2 text-sm outline-none focus:border-primary"
                  spellCheck={false}
                />
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Lance le serveur dans LM Studio (onglet « Local Server ») et active CORS.
                </p>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-foreground">
                  Nom du modèle
                </label>
                <input
                  type="text"
                  value={settings.lmstudioModel}
                  onChange={(e) => update("lmstudioModel", e.target.value)}
                  placeholder="ex: qwen2.5-coder-7b-instruct"
                  className="w-full rounded-md border border-border bg-input px-2 py-2 text-sm outline-none focus:border-primary"
                  spellCheck={false}
                />
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  L'identifiant exact du modèle chargé dans LM Studio.
                </p>
              </div>
              <div>
                <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <KeyRound className="h-3.5 w-3.5" /> API Key (optionnel)
                </label>
                <div className="flex items-center gap-2 rounded-md border border-border bg-input px-2 focus-within:border-primary">
                  <input
                    type={showLmKey ? "text" : "password"}
                    value={settings.lmstudioApiKey}
                    onChange={(e) => update("lmstudioApiKey", e.target.value)}
                    placeholder="lm-studio (par défaut) ou laisser vide"
                    className="flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => setShowLmKey((v) => !v)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {showLmKey ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  LM Studio n'exige pas de clé par défaut. Renseigne-la seulement si tu as activé l'authentification.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleTestLmStudio}
                  disabled={
                    testing ||
                    !settings.lmstudioBaseUrl.trim() ||
                    !settings.lmstudioModel.trim()
                  }
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-input px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
                >
                  {testing ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Test en cours…
                    </>
                  ) : (
                    <>Tester la connexion</>
                  )}
                </button>
                {testResult && (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 text-[11px]",
                      testResult.ok ? "text-primary" : "text-destructive",
                    )}
                  >
                    {testResult.ok ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5" />
                    )}
                    {testResult.message}
                  </span>
                )}
              </div>
              <div className="rounded border border-border bg-muted p-2 text-[11px] text-muted-foreground">
                ⚠️ L'appel se fait directement depuis ton navigateur vers LM Studio.
                Ça ne marchera que si LM Studio tourne sur la même machine que celle où tu ouvres l'aperçu, et si CORS est activé dans LM Studio.
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={
              (settings.provider === "openai" && !settings.openaiApiKey.trim()) ||
              (settings.provider === "lmstudio" &&
                (!settings.lmstudioBaseUrl.trim() || !settings.lmstudioModel.trim()))
            }
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function ProviderCard({
  active,
  onClick,
  title,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-md border p-3 text-left transition",
        active
          ? "border-primary bg-primary/10"
          : "border-border bg-[var(--sidebar-bg)] hover:border-primary/50",
      )}
    >
      <div className="text-sm font-medium text-foreground">{title}</div>
      <div className="mt-1 text-[11px] text-muted-foreground">{desc}</div>
    </button>
  );
}
