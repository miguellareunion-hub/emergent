import { createFileRoute } from "@tanstack/react-router";

/**
 * Built-in runner — HTTP fetch proxy. Lets the agent curl URLs from the server
 * side (e.g. to verify a newly started server responds, or to test an external
 * API). Response body is truncated to 20KB.
 */

const RUNNER_TOKEN = process.env.RUNNER_TOKEN || "lovable-ide-local";
const MAX_BODY_BYTES = 20_000;

type FetchBody = {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = (createFileRoute as any)("/api/http-fetch")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const auth = request.headers.get("authorization") || "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (token !== RUNNER_TOKEN) {
          return json({ error: "Bad runner token" }, 401);
        }
        const body = (await request.json()) as FetchBody;
        const { url, method = "GET", headers = {}, body: reqBody } = body;
        if (!url || !/^https?:\/\//i.test(url)) {
          return json({ error: "valid http(s) url required" }, 400);
        }
        try {
          const r = await fetch(url, {
            method,
            headers,
            body: reqBody,
            signal: AbortSignal.timeout(30_000),
          });
          const text = await r.text();
          return json({
            status: r.status,
            statusText: r.statusText,
            body: text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) + "\n…(truncated)" : text,
          });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "fetch failed" }, 500);
        }
      },
    },
  },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
