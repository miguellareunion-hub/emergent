export type AIProvider = "lovable" | "openai" | "lmstudio";

export type AISettings = {
  provider: AIProvider;
  openaiApiKey: string;
  openaiModel: string;
  lovableModel: string;
  lmstudioBaseUrl: string;
  lmstudioModel: string;
  lmstudioApiKey: string;
};

const STORAGE_KEY = "lovable-ide:ai-settings";

export const DEFAULT_SETTINGS: AISettings = {
  provider: "lovable",
  openaiApiKey: "",
  openaiModel: "gpt-4o-mini",
  lovableModel: "google/gemini-3-flash-preview",
  lmstudioBaseUrl: "http://localhost:1234/v1",
  lmstudioModel: "local-model",
  lmstudioApiKey: "",
};

export const OPENAI_MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
  "gpt-4",
  "gpt-3.5-turbo",
  "o1-mini",
  "o1-preview",
];

export const LOVABLE_MODELS = [
  "google/gemini-3-flash-preview",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-pro",
  "openai/gpt-5",
  "openai/gpt-5-mini",
  "openai/gpt-5-nano",
];

export function loadAISettings(): AISettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AISettings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveAISettings(settings: AISettings) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
