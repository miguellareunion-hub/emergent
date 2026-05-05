import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  vite: {
    server: {
      host: "0.0.0.0",
      port: 3000,
      allowedHosts: [".preview.emergentagent.com", ".emergentcf.cloud", ".preview.emergentcf.cloud", "localhost"],
      hmr: {
        clientPort: 443,
        protocol: "wss",
      },
    },
  },
});
