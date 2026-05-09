import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { loadEnv } from "vite";

// Load .env into process.env so server-side handlers (api.chat.ts) can use them.
const env = loadEnv("development", process.cwd(), "");
for (const k of Object.keys(env)) {
  if (process.env[k] === undefined) process.env[k] = env[k];
}
// Ensure Playwright finds the bundled browsers no matter where the dev server
// was started from.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = `${process.cwd()}/.playwright-browsers`;
}

export default defineConfig({
  vite: {
    server: {
      host: "0.0.0.0",
      port: 3000,
      allowedHosts: [".preview.emergentagent.com", ".emergentcf.cloud", ".preview.emergentcf.cloud", "localhost"],
      hmr: false,
      watch: {
        ignored: ["**/*"],
      },
    },
  },
});
