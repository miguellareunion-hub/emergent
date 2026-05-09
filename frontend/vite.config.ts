import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { loadEnv } from "vite";

// Load .env into process.env so server-side handlers (api.chat.ts, api.qa.ts)
// can read EMERGENT_LLM_KEY, RUNNER_TOKEN, PLAYWRIGHT_BROWSERS_PATH, etc.
const env = loadEnv("development", process.cwd(), "");
for (const k of Object.keys(env)) {
  if (process.env[k] === undefined) process.env[k] = env[k];
}
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = `${process.cwd()}/.playwright-browsers`;
}

export default defineConfig({
  vite: {
    server: {
      host: "0.0.0.0",
      port: 3000,
      allowedHosts: [
        ".preview.emergentagent.com",
        ".emergentcf.cloud",
        ".preview.emergentcf.cloud",
        "localhost",
      ],
      hmr: false,
      watch: {
        ignored: ["**/*"],
      },
    },
    // Playwright is server-only (used by /api/qa). Without these excludes,
    // Vite tries to pre-bundle playwright-core during dependency optimisation
    // and fails on dynamic chromium-bidi sub-path imports — which crashes the
    // whole dev server. Treating them as external for both browser bundling
    // and SSR avoids that.
    optimizeDeps: {
      exclude: ["playwright", "playwright-core", "chromium-bidi"],
    },
    ssr: {
      external: ["playwright", "playwright-core", "chromium-bidi"],
    },
  },
});
