export type RunnerSettings = {
  url: string;
  token: string;
  script: string;
};

const STORAGE_KEY = "lovable-ide:runner-settings";
const MIGRATION_KEY = "lovable-ide:runner-migration-v2";

/**
 * Default runner settings — point to the BUILT-IN runner that ships with this
 * IDE (TanStack Start server routes at /api/exec, /api/http-fetch). Using an
 * empty URL means "same origin", and the default token matches the one the
 * server accepts when RUNNER_TOKEN is not explicitly set.
 */
export const DEFAULT_RUNNER_SETTINGS: RunnerSettings = {
  url: "",
  token: "lovable-ide-local",
  script: "dev",
};

export function loadRunnerSettings(): RunnerSettings {
  if (typeof window === "undefined") return DEFAULT_RUNNER_SETTINGS;
  try {
    // One-time migration: upgrade old configs (empty token OR localhost:7070)
    // to the new built-in runner defaults.
    const migrated = localStorage.getItem(MIGRATION_KEY) === "1";
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      if (!migrated) {
        try {
          localStorage.setItem(MIGRATION_KEY, "1");
        } catch {
          /* */
        }
      }
      return DEFAULT_RUNNER_SETTINGS;
    }
    const parsed = JSON.parse(raw) as Partial<RunnerSettings>;
    const merged = { ...DEFAULT_RUNNER_SETTINGS, ...parsed };
    if (
      !migrated &&
      (merged.token === "" || /localhost:7070/.test(merged.url))
    ) {
      const upgraded: RunnerSettings = {
        url: DEFAULT_RUNNER_SETTINGS.url,
        token: DEFAULT_RUNNER_SETTINGS.token,
        script: merged.script || DEFAULT_RUNNER_SETTINGS.script,
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(upgraded));
        localStorage.setItem(MIGRATION_KEY, "1");
      } catch {
        /* */
      }
      return upgraded;
    }
    if (!migrated) {
      try {
        localStorage.setItem(MIGRATION_KEY, "1");
      } catch {
        /* */
      }
    }
    return merged;
  } catch {
    return DEFAULT_RUNNER_SETTINGS;
  }
}

export function saveRunnerSettings(s: RunnerSettings) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}
