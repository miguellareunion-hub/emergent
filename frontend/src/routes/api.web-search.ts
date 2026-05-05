import { createFileRoute } from "@tanstack/react-router";

/**
 * Lightweight web search endpoint for agent tools.
 * Uses DuckDuckGo's HTML endpoint (no API key required) and returns
 * the top 5 organic results as { title, url, snippet }.
 *
 * NOTE: this is a best-effort scraping endpoint — DuckDuckGo may rate-limit
 * or change markup. If the call fails we return { results: [] } instead of
 * throwing so the agent can continue.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = (createFileRoute as any)("/api/web-search")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        try {
          const { query } = (await request.json()) as { query?: string };
          if (!query || !query.trim()) {
            return json({ results: [], error: "empty query" }, 400);
          }
          const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query.trim())}`;
          const r = await fetch(url, {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
              Accept: "text/html",
            },
          });
          if (!r.ok) {
            return json({ results: [], error: `search HTTP ${r.status}` });
          }
          const html = await r.text();
          const results = parseDuckDuckGo(html).slice(0, 5);
          return json({ results });
        } catch (e) {
          return json({
            results: [],
            error: e instanceof Error ? e.message : "search failed",
          });
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

type SearchHit = { title: string; url: string; snippet: string };

function parseDuckDuckGo(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  // Each result block on the HTML endpoint
  const blockRe = /<div class="result results_links[^"]*"[\s\S]*?<\/div>\s*<\/div>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null && hits.length < 10) {
    const block = m[0];
    const a = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    const s = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    const rawHref = a[1];
    const title = stripTags(a[2]);
    const snippet = s ? stripTags(s[1]) : "";
    let resolved = rawHref;
    // DuckDuckGo wraps real URLs in /l/?uddg=…
    const u = rawHref.match(/[?&]uddg=([^&]+)/);
    if (u) {
      try {
        resolved = decodeURIComponent(u[1]);
      } catch {
        /* keep raw */
      }
    }
    hits.push({ title, url: resolved, snippet });
  }
  return hits;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
