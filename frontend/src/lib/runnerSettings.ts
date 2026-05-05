export type RunnerSettings = {
  url: string;
  token: string;
  script: string;
};

const STORAGE_KEY = "lovable-ide:runner-settings";

export const DEFAULT_RUNNER_SETTINGS: RunnerSettings = {
  url: "http://localhost:7070",
  token: "",
  script: "dev",
};

export function loadRunnerSettings(): RunnerSettings {
  if (typeof window === "undefined") return DEFAULT_RUNNER_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_RUNNER_SETTINGS;
    return { ...DEFAULT_RUNNER_SETTINGS, ...(JSON.parse(raw) as Partial<RunnerSettings>) };
  } catch {
    return DEFAULT_RUNNER_SETTINGS;
  }
}

export function saveRunnerSettings(s: RunnerSettings) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}
