import { createFileRoute } from "@tanstack/react-router";

type AgentRole = "builder" | "fixer" | "planner";

type ChatBody = {
  messages: { role: "user" | "assistant" | "system" | "tool"; content: string; tool_call_id?: string; tool_calls?: unknown }[];
  provider?: "lovable" | "openai";
  model?: string;
  openaiApiKey?: string;
  role?: AgentRole;
  systemPromptOverride?: string;
  tools?: unknown[];
  tool_choice?: unknown;
  nonStreaming?: boolean;
};

const BASE_RULES = `# Environment constraints
- The IDE preview runs in a sandboxed iframe (HTML/CSS/JS) OR in the local Node Runner if the user enabled it.
- **Stack selection (CRITICAL)** — pick the runtime BEFORE writing any file:
  - **Node project** (write a \`package.json\` + \`server.js\` / \`index.js\`) IF the user mentions ANY of: "node", "nodejs", "node.js", "express", "serveur", "server", "backend", "API", "REST", "websocket", "ws", "socket.io", "bot" (trading bot, discord bot, telegram bot…), "binance", "ccxt", "scraping", "puppeteer", "cron", "cli", "scheduler", "database", "postgres", "mysql", "mongodb", "prisma", "axios" used server-side, "fetch" to a private API with secret keys, OR anything that needs \`process.env\` for SECRET keys (API keys that must NOT leak to the browser).
  - **Browser project** (\`index.html\` + \`style.css\` + \`script.js\`, NO package.json) ONLY for pure UI demos: landing page, calculator, todo list, game, animation, portfolio, form with no secret backend.
  - When in doubt → choose Node. A trading bot, a price tracker hitting an exchange, anything touching real money or private credentials is ALWAYS Node.
- A Node project MUST include: \`package.json\` with \`"scripts": { "dev": "node server.js" }\` (or "start"), the entry file referenced in scripts, and \`"type": "module"\` if you use \`import/export\` syntax. Add \`"dependencies"\` for every \`import\` of an npm package.
- A Node project MUST NOT contain an \`index.html\` as the main UI unless it is served BY the Node server (e.g. \`app.use(express.static('public'))\`). If you need a UI, put it under \`public/\` and serve it from express.


# Action tags (the IDE parses these and applies them automatically)
To create or fully overwrite a file:
<lov-write path="index.html">
<!DOCTYPE html>
<html>...COMPLETE file content...</html>
</lov-write>

To rename a file:
<lov-rename from="old.js" to="new.js" />

To delete a file:
<lov-delete path="obsolete.css" />

# CRITICAL RULES — output format
- Always output COMPLETE file contents inside <lov-write>. Never partial diffs, placeholders, or 'rest of file'.
- Do NOT wrap file contents in markdown code fences inside <lov-write>.
- Use simple filenames at project root or under a single subfolder (e.g. lib/foo.js). No deep nesting unless needed.
- Before action tags, briefly explain what you are changing. After actions, briefly summarize the result.
- For pure questions without code edits, answer in markdown only. Be concise.

# CRITICAL RULES — code correctness (read carefully, this is what breaks projects)
1. **Imports must match exports.** If \`engine.js\` writes \`import { binance } from './binance.js'\`, then \`binance.js\` MUST contain \`export const binance = ...\` (or \`export function binance\`, or \`export { binance }\`). Default exports (\`export default X\`) need \`import X from './...'\` — NOT \`import { X } from './...'\`. Mixing the two is the #1 cause of "does not provide an export named X" errors.
2. **Every imported file must exist.** If a file imports \`./lib/foo.js\`, you MUST also emit \`<lov-write path="lib/foo.js">\` in the same response. Same for \`<script src="app.js">\` in HTML — \`app.js\` must be written.
3. **One module style per project.** If you put \`"type": "module"\` in package.json, every \`.js\` file must use \`import/export\`, NOT \`require\`/\`module.exports\`. Pick one and stay consistent.
4. **Node entry point clarity.** For Node projects, the file mentioned in \`package.json\` "main" or in \`scripts.start\` MUST exist (e.g. if \`"start": "node server.js"\`, write \`server.js\`).
5. **Env vars and secrets.** For API keys, read from \`process.env.XXX\` and put a placeholder \`.env.example\` file. Never hardcode secrets.

# When the project already has files (MODIFICATION mode)
- The <context> block lists every existing file. You MUST work with that exact list.
- **DEFAULT BEHAVIOR**: when files already exist, the user is asking for an INCREMENTAL CHANGE. Re-emit ONLY the file(s) that need to change. NEVER re-emit unchanged files.
- **Forbidden**: rewriting the entire project just because the user reported a small bug ("je ne peux pas activer le bot", "le bouton ne marche pas", etc.). These are TARGETED FIXES — touch 1-3 files MAX.
- **Forbidden**: deleting files the user did not explicitly ask to delete.
- To replace a project entirely, the user must say so explicitly ("recommence à zéro", "nouveau projet", "from scratch"). Only then may you DELETE every existing file with <lov-delete> and re-emit a fresh set.
- Never leave behind unrelated leftover files from a previous app.
- Every file referenced (HTML <script>, JS imports, CSS @import) MUST exist after your changes — either already in <context> or written in this response.`;

const BUILDER_PROMPT = `You are the BUILDER agent of an autonomous multi-agent system inside Lovable IDE.
Your job: design and write working client-side projects from the user's request.
${BASE_RULES}`;

const FIXER_PROMPT = `You are the FIXER agent of an autonomous multi-agent system inside Lovable IDE.
The BUILDER agent just wrote code that produced errors — either at validation time (static check), in the browser preview, or in the Node runner.

Your job: read the error messages in the user's message, identify the ROOT cause, and emit corrected files using <lov-write> tags.

# Common error patterns and how to fix them
- "does not provide an export named 'X'" → the importing file expects \`export const X\` or \`export function X\` in the target file. Either add the named export, or change the import to default style.
- "Cannot find module './X'" / "ERR_MODULE_NOT_FOUND" → the imported file was never written. Create it, or fix the import path.
- "X is not defined" / ReferenceError → either an undeclared variable, a missing import, or a typo. Re-check spelling.
- "Cannot read properties of null/undefined" → guard with optional chaining (\`?.\`) or check the value exists before using it.
- "EADDRINUSE" → another process is using the port. Either change the port in the code or warn the user.
- "Unexpected token" / SyntaxError → real syntax error in the emitted file. Re-write the file with correct syntax.

# Hard requirements
- Output corrected files only — re-emit each broken file in full with <lov-write>.
- Fix the ACTUAL root cause, not symptoms. Don't catch errors silently to hide them.
- Do NOT apologize, do NOT restate the user's prompt, do NOT add unrelated features.
- If you change \`a.js\`'s exports, also re-check every file that imports from \`a.js\` and re-emit them too if needed.
- After your fixes, briefly explain what was wrong (1–2 sentences).
${BASE_RULES}`;

const PLANNER_PROMPT = `You are the PLANNER agent of an autonomous multi-agent system inside Lovable IDE.
Your job: take a LONG or COMPLEX user request and split it into 2 to 8 SMALL, ORDERED, INDEPENDENT build steps that the BUILDER agent will execute one after the other.

Rules:
- Output ONLY valid JSON (no prose, no markdown fences). Schema:
  { "steps": [ { "title": "short title", "instruction": "concrete instruction for the builder, in the same language as the user prompt" } ] }
- Each step must be small enough to be implemented in a single response (one or a few files).
- Step 1 is ALWAYS the base structure (skeleton: package.json or index.html + main entry file + main CSS).
- Following steps add features INCREMENTALLY on top of the previous step. They must NOT recreate files from scratch — they patch / extend.
- **For big multi-file projects** (when the user lists 8+ files or many features), you MAY use up to 8 steps and SHOULD group related files together (e.g. step "backend skeleton" = server.js + config.json + JSON storage; step "bot core" = strategy.js + indicators.js + binance.js).
- **Every file mentioned by the user MUST appear in at least one step's instruction** — do not skip any.
- Keep instructions short (1-3 sentences each). The builder already knows the global goal from step 1.
- Do NOT add deployment, testing, documentation, or "polish" steps unless the user explicitly asks for them.
- If the user request is small/simple (1-3 files), output a single step.

Environment: a sandboxed Node Runner OR a browser iframe preview (HTML/CSS/JS). The runner may be unavailable — in that case the BUILDER will simply emit files without running them. Files live at the project root or in a single subfolder.`;

function getSystemPrompt(role: AgentRole): string {
  if (role === "fixer") return FIXER_PROMPT;
  if (role === "planner") return PLANNER_PROMPT;
  return BUILDER_PROMPT;
}

/**
 * Map a UI-side model id (e.g. "google/gemini-3-flash-preview", "openai/gpt-5",
 * "anthropic/claude-sonnet-4-5-20250929") to the format expected by the
 * Emergent integrations proxy (LiteLLM-style).
 */
function mapEmergentModel(uiModel: string): string {
  const m = uiModel.trim();
  if (m.startsWith("google/")) return `gemini/${m.slice("google/".length)}`;
  if (m.startsWith("gemini/")) return m;
  if (m.startsWith("openai/")) return m.slice("openai/".length);
  if (m.startsWith("anthropic/")) return m.slice("anthropic/".length);
  // Bare model name — assume OpenAI by default (gpt-*) or already correct.
  return m;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = (createFileRoute as any)("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        try {
          const body = (await request.json()) as ChatBody;
          const {
            messages,
            provider = "lovable",
            model,
            openaiApiKey,
            role = "builder",
            systemPromptOverride,
            tools,
            tool_choice,
            nonStreaming,
          } = body;

          let url: string;
          let apiKey: string | undefined;
          let chosenModel: string;
          const extraHeaders: Record<string, string> = {};

          if (provider === "openai") {
            url = "https://api.openai.com/v1/chat/completions";
            apiKey = openaiApiKey?.trim();
            chosenModel = model || "gpt-4o-mini";
            if (!apiKey) {
              return jsonError(
                "OpenAI API key is missing. Open Settings and paste your key.",
                400,
              );
            }
          } else {
            // "lovable" branch — now backed by the Emergent universal LLM key
            // via the integrations proxy (OpenAI-compatible, supports streaming
            // SSE and tool calling).
            const proxyBase =
              process.env.INTEGRATION_PROXY_URL ||
              "https://integrations.emergentagent.com";
            // Prefer the universal Emergent key, but fall back to a legacy
            // LOVABLE_API_KEY if the operator wires one in.
            apiKey = process.env.EMERGENT_LLM_KEY || process.env.LOVABLE_API_KEY;
            if (apiKey?.startsWith("sk-emergent-")) {
              url = `${proxyBase.replace(/\/$/, "")}/llm/chat/completions`;
              chosenModel = mapEmergentModel(model || "google/gemini-3-flash-preview");
              if (process.env.APP_URL) {
                extraHeaders["X-App-ID"] = process.env.APP_URL;
              }
            } else {
              // Legacy Lovable AI gateway fallback.
              url = "https://ai.gateway.lovable.dev/v1/chat/completions";
              chosenModel = model || "google/gemini-3-flash-preview";
            }
            if (!apiKey) {
              return jsonError(
                "No LLM key configured. Set EMERGENT_LLM_KEY in /app/frontend/.env",
                500,
              );
            }
          }

          const systemPrompt =
            systemPromptOverride && systemPromptOverride.trim().length > 0
              ? systemPromptOverride
              : getSystemPrompt(role);

          const useStreaming = !nonStreaming;
          const payload: Record<string, unknown> = {
            model: chosenModel,
            stream: useStreaming,
            messages: [{ role: "system", content: systemPrompt }, ...messages],
            // Allow the model to emit large multi-file responses without
            // getting truncated mid-write_file.
            max_tokens: 16384,
          };
          if (Array.isArray(tools) && tools.length > 0) {
            payload.tools = tools;
            if (tool_choice !== undefined) payload.tool_choice = tool_choice;
          }

          const upstream = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              ...extraHeaders,
            },
            body: JSON.stringify(payload),
          });

          if (!upstream.ok) {
            if (upstream.status === 429) {
              return jsonError("Rate limit exceeded. Please try again shortly.", 429);
            }
            if (upstream.status === 401) {
              return jsonError(
                provider === "openai"
                  ? "Invalid OpenAI API key. Check it in Settings."
                  : "Unauthorized to AI gateway. Check EMERGENT_LLM_KEY.",
                401,
              );
            }
            if (upstream.status === 402) {
              return jsonError(
                "AI credits exhausted. Top up your Emergent universal key from Profile → Universal Key.",
                402,
              );
            }
            const text = await upstream.text();
            console.error("AI provider error", provider, upstream.status, text);
            return jsonError(`AI provider error (${upstream.status}): ${text.slice(0, 200)}`, 500);
          }

          if (useStreaming) {
            return new Response(upstream.body, {
              headers: { "Content-Type": "text/event-stream" },
            });
          }
          const respText = await upstream.text();
          return new Response(respText, {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          console.error("/api/chat error", e);
          return jsonError(e instanceof Error ? e.message : "Unknown error", 500);
        }
      },
    },
  },
});

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
