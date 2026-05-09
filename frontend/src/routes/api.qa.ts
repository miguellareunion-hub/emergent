import { createFileRoute } from "@tanstack/react-router";

/**
 * QA_AGENT — Autonomous browser-based QA endpoint
 * ----------------------------------------------
 * Receives a project (HTML doc OR a URL), opens it in a real headless Chromium
 * via Playwright, observes the page for 6 seconds, and returns a structured
 * report describing every detectable problem.
 *
 * The QA agent NEVER:
 *   - creates files
 *   - modifies sources
 *   - rewrites code
 * It only OBSERVES, ANALYZES, REPORTS, VALIDATES.
 *
 * Browser binaries are bundled under /app/frontend/.playwright-browsers/ and
 * found via the PLAYWRIGHT_BROWSERS_PATH env (set in vite.config.ts so both
 * dev and prod work).
 */

const RUNNER_TOKEN = process.env.RUNNER_TOKEN || "lovable-ide-local";

type QABody = {
  /** Either a URL to navigate to OR a full HTML doc to load via `setContent`. */
  url?: string;
  html?: string;
  /** Viewport for "responsive" check. */
  viewport?: { width: number; height: number };
  /** When set, also test mobile viewport (375x812) and report deltas. */
  testMobile?: boolean;
  /** Hard time budget (default 8s, max 20s). */
  timeoutMs?: number;
};

type QAReport = {
  status: "ok" | "warn" | "fail";
  summary: string;
  navigation: {
    finalUrl: string;
    httpStatus: number | null;
    loadTimeMs: number;
    blank: boolean;
    title: string;
  };
  console: Array<{ level: string; text: string }>;
  pageErrors: Array<{ message: string; stack?: string }>;
  failedRequests: Array<{ url: string; method: string; status: number | null; reason: string }>;
  ui: {
    hasContent: boolean;
    bodyTextLength: number;
    elementCounts: Record<string, number>;
    missingExpected: string[];
    visibleButtons: number;
    visibleInputs: number;
    images: { total: number; broken: number };
  };
  responsive: {
    desktopOverflow: boolean;
    mobileOverflow: boolean;
    horizontalScrollAt375: boolean;
  };
  screenshots: { desktop?: string; mobile?: string };
  recommendations: string[];
  durationMs: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = (createFileRoute as any)("/api/qa")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const auth = request.headers.get("authorization") || "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (token !== RUNNER_TOKEN) {
          return json({ error: "Bad runner token" }, 401);
        }

        const body = (await request.json()) as QABody;
        const { url, html, viewport, testMobile, timeoutMs } = body;
        if (!url && !html) {
          return json({ error: "url or html required" }, 400);
        }

        const t0 = Date.now();
        const limit = Math.min(Math.max(timeoutMs ?? 8000, 2000), 20000);

        // Lazy import — keeps the browser bundle clean.
        if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
          process.env.PLAYWRIGHT_BROWSERS_PATH =
            "/app/frontend/.playwright-browsers";
        }
        const { chromium } = await import("playwright");

        let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
        try {
          browser = await chromium.launch({
            headless: true,
            args: [
              "--no-sandbox",
              "--disable-dev-shm-usage",
              "--disable-gpu",
            ],
          });
          const ctx = await browser.newContext({
            viewport: viewport ?? { width: 1280, height: 800 },
          });
          const page = await ctx.newPage();

          const consoleEntries: QAReport["console"] = [];
          const pageErrors: QAReport["pageErrors"] = [];
          const failedRequests: QAReport["failedRequests"] = [];

          page.on("console", (msg) => {
            const lvl = msg.type();
            if (lvl === "error" || lvl === "warning" || lvl === "info") {
              consoleEntries.push({ level: lvl, text: msg.text().slice(0, 400) });
            }
          });
          page.on("pageerror", (err) => {
            pageErrors.push({
              message: err.message.slice(0, 400),
              stack: err.stack?.split("\n").slice(0, 3).join("\n"),
            });
          });
          page.on("requestfailed", (req) => {
            failedRequests.push({
              url: req.url().slice(0, 240),
              method: req.method(),
              status: null,
              reason: req.failure()?.errorText || "request failed",
            });
          });
          page.on("response", (res) => {
            const status = res.status();
            if (status >= 400) {
              failedRequests.push({
                url: res.url().slice(0, 240),
                method: res.request().method(),
                status,
                reason: res.statusText() || `HTTP ${status}`,
              });
            }
          });

          // ---- 1. Navigation ----
          let httpStatus: number | null = null;
          const navStart = Date.now();
          try {
            if (url) {
              const resp = await page.goto(url, {
                waitUntil: "domcontentloaded",
                timeout: limit,
              });
              httpStatus = resp?.status() ?? null;
            } else {
              await page.setContent(html as string, {
                waitUntil: "domcontentloaded",
                timeout: limit,
              });
            }
          } catch (e) {
            // Retry once with a longer timeout if the first attempt failed.
            try {
              if (url) await page.goto(url, { waitUntil: "load", timeout: limit });
            } catch (e2) {
              pageErrors.push({
                message: `Navigation failed: ${(e2 as Error).message}`,
              });
            }
          }
          const loadTimeMs = Date.now() - navStart;
          // Give scripts a beat to attach handlers / fire async work.
          await page.waitForTimeout(1500);

          // ---- 2. UI analysis ----
          const ui = await page.evaluate(() => {
            const safeText = (document.body?.innerText || "").trim();
            const visibleCount = (sel: string) => {
              return Array.from(document.querySelectorAll<HTMLElement>(sel)).filter(
                (el) => {
                  const r = el.getBoundingClientRect();
                  const cs = getComputedStyle(el);
                  return (
                    r.width > 0 &&
                    r.height > 0 &&
                    cs.visibility !== "hidden" &&
                    cs.display !== "none"
                  );
                },
              ).length;
            };
            const counts: Record<string, number> = {};
            ["nav", "header", "footer", "main", "section", "form", "button", "input", "a", "img", "h1", "h2"]
              .forEach((t) => (counts[t] = document.querySelectorAll(t).length));
            const imgs = Array.from(document.images);
            const broken = imgs.filter((i) => !i.complete || i.naturalWidth === 0).length;
            // Detect missing common elements when the page actually has content.
            const missing: string[] = [];
            if (safeText.length > 50) {
              if (counts.h1 === 0 && counts.h2 === 0) missing.push("heading (h1/h2)");
              if (counts.button === 0 && counts.a < 1) missing.push("interactive controls");
            }
            return {
              hasContent: safeText.length > 0,
              bodyTextLength: safeText.length,
              elementCounts: counts,
              missingExpected: missing,
              visibleButtons: visibleCount("button"),
              visibleInputs: visibleCount("input,textarea,select"),
              images: { total: imgs.length, broken },
            };
          });

          const blank =
            !ui.hasContent ||
            (ui.bodyTextLength < 5 &&
              ui.elementCounts.button === 0 &&
              ui.elementCounts.h1 + ui.elementCounts.h2 === 0);

          // ---- 3. Screenshots ----
          const desktopShot = (await page.screenshot({ type: "jpeg", quality: 60, fullPage: false })).toString("base64");

          // ---- 4. Responsive ----
          const desktopOverflow = await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth + 4,
          );
          let mobileOverflow = false;
          let horizontalScrollAt375 = false;
          let mobileShot: string | undefined;
          if (testMobile !== false) {
            await page.setViewportSize({ width: 375, height: 812 });
            await page.waitForTimeout(300);
            mobileOverflow = await page.evaluate(
              () => document.documentElement.scrollWidth > window.innerWidth + 4,
            );
            horizontalScrollAt375 = mobileOverflow;
            mobileShot = (
              await page.screenshot({ type: "jpeg", quality: 55, fullPage: false })
            ).toString("base64");
          }

          await ctx.close();
          await browser.close();
          browser = null;

          // ---- 5. Verdict + recommendations ----
          const recommendations: string[] = [];
          if (blank) recommendations.push("BLANK_PAGE: write content into <body> or fix the JS that builds the UI");
          if (pageErrors.length > 0)
            recommendations.push(
              `JS_ERROR(${pageErrors.length}): fix the runtime exceptions reported by pageErrors[]`,
            );
          if (httpStatus && httpStatus >= 400)
            recommendations.push(`HTTP_${httpStatus}: server route is missing or broken`);
          if (failedRequests.length > 0)
            recommendations.push(
              `FAILED_REQUESTS(${failedRequests.length}): fix the broken endpoints / wrong URLs`,
            );
          if (ui.images.broken > 0)
            recommendations.push(`BROKEN_IMAGES(${ui.images.broken}): fix the <img src=> paths`);
          if (ui.missingExpected.length > 0)
            recommendations.push(
              "MISSING_UI: " + ui.missingExpected.join(", "),
            );
          if (mobileOverflow)
            recommendations.push("RESPONSIVE: layout overflows at 375px, add media queries / max-width: 100%");
          if (consoleEntries.filter((c) => c.level === "error").length > 0)
            recommendations.push("CONSOLE_ERROR: clean up console.error() output");

          const errCount =
            pageErrors.length +
            consoleEntries.filter((c) => c.level === "error").length +
            failedRequests.length;
          const status: QAReport["status"] = blank || errCount >= 3
            ? "fail"
            : errCount > 0 || ui.missingExpected.length > 0 || mobileOverflow
              ? "warn"
              : "ok";

          const report: QAReport = {
            status,
            summary:
              status === "ok"
                ? "✅ Project loaded cleanly with no detectable issues."
                : status === "warn"
                  ? "⚠ Project loads but has issues that should be fixed."
                  : "❌ Project has serious problems and is not working as expected.",
            navigation: {
              finalUrl: page.url() || url || "(inline html)",
              httpStatus,
              loadTimeMs,
              blank,
              title: await page.title().catch(() => ""),
            },
            console: consoleEntries.slice(0, 30),
            pageErrors: pageErrors.slice(0, 10),
            failedRequests: failedRequests.slice(0, 20),
            ui,
            responsive: {
              desktopOverflow,
              mobileOverflow,
              horizontalScrollAt375,
            },
            screenshots: {
              desktop: `data:image/jpeg;base64,${desktopShot}`,
              mobile: mobileShot ? `data:image/jpeg;base64,${mobileShot}` : undefined,
            },
            recommendations,
            durationMs: Date.now() - t0,
          };
          return json(report);
        } catch (e) {
          return json(
            {
              status: "fail",
              summary: `QA agent crashed: ${(e as Error).message}`,
              error: (e as Error).message,
            },
            500,
          );
        } finally {
          if (browser) {
            try {
              await browser.close();
            } catch {
              /* */
            }
          }
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
