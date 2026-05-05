/**
 * Agent tools — gives the AI agents the same kind of capabilities the IDE's
 * own meta-agent has: read/write/delete files, run shell commands, search the
 * web, fetch HTTP, list files, read runner logs.
 *
 * Two pieces:
 *   1. TOOL_DEFS — JSON-schema definitions sent to the OpenAI-compatible API
 *      so the model emits structured tool calls.
 *   2. executeTool() — runs a single tool call locally (in the browser) using
 *      the IDE's existing infra (file callbacks + runner-server HTTP API).
 */

import type { FileNode } from "@/lib/projects";
import { loadRunnerSettings } from "@/lib/runnerSettings";

// ---------------------------------------------------------------------------
//  Tool JSON-Schema definitions (OpenAI tool-calling format)
// ---------------------------------------------------------------------------

export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the FULL content of a file in the project. Use before modifying a file you haven't seen yet.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative file path, e.g. 'index.html' or 'lib/utils.js'" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List every file currently in the project (name + size).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create a new file or fully overwrite an existing one. ALWAYS provide the COMPLETE file content — never partial diffs.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative file path." },
          content: { type: "string", description: "The full file content as a single string." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rename_file",
      description: "Rename or move a file inside the project.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
        },
        required: ["from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file from the project. Only use when the user explicitly asked to remove it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "exec_shell",
      description:
        "Run a shell command in the LOCAL Node Runner workspace (npm install, node script.js, ls, cat, git, etc.). Returns stdout/stderr/exitCode. Requires the runner to be configured with a token. Default timeout: 30s, max 120s.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The full shell command, e.g. 'npm install axios'." },
          cwd: {
            type: "string",
            description: "Optional sub-directory of the project workspace to run the command in.",
          },
          timeoutMs: { type: "integer", description: "Optional timeout in ms (1000–120000)." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "http_fetch",
      description:
        "Make an HTTP request from the Node Runner's machine. Useful to test that the project's own server responds, or to fetch a public API. Returns status + body (truncated to 20KB).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] },
          headers: { type: "object", additionalProperties: { type: "string" } },
          body: { type: "string" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for documentation, code examples, error messages, or library versions. Returns up to 5 results (title, url, snippet).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description:
        "Signal that you are done with the user's request. After calling this, do NOT call any other tools — just write your final summary in plain text.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Short summary of what you did." },
        },
        required: ["summary"],
      },
    },
  },
] as const;

// ---------------------------------------------------------------------------
//  Tool executor — runs ONE tool call locally
// ---------------------------------------------------------------------------

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type ToolContext = {
  projectId: string;
  getFiles: () => FileNode[];
  onWriteFile: (path: string, content: string) => void;
  onRenameFile: (from: string, to: string) => void;
  onDeleteFile: (path: string) => void;
};

export type ToolResult = {
  ok: boolean;
  /** Short human-readable label for chat UI. */
  label: string;
  /** Stringified JSON content fed back to the model. */
  content: string;
};

const MAX_RESULT_CHARS = 18000;

function clip(s: string): string {
  return s.length > MAX_RESULT_CHARS ? s.slice(0, MAX_RESULT_CHARS) + "\n…(truncated)" : s;
}

async function runnerCall<T = unknown>(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const s = loadRunnerSettings();
  if (!s.token || !s.url) {
    return {
      ok: false,
      error:
        "Runner not configured. Open the Node Runner panel and set URL + token first.",
    };
  }
  try {
    const r = await fetch(`${s.url.replace(/\/+$/, "")}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${s.token}`,
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* keep raw */
    }
    if (!r.ok) {
      return {
        ok: false,
        error: `HTTP ${r.status}: ${typeof json === "string" ? json : JSON.stringify(json)}`,
      };
    }
    return { ok: true, data: json as T };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "network error" };
  }
}

export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const args = call.args || {};
  switch (call.name) {
    case "read_file": {
      const p = String(args.path || "").trim();
      const f = ctx.getFiles().find((x) => x.name === p);
      if (!f) {
        return {
          ok: false,
          label: `Lecture impossible: ${p}`,
          content: JSON.stringify({ error: `File "${p}" does not exist in the project.` }),
        };
      }
      return {
        ok: true,
        label: `Lu ${p}`,
        content: clip(JSON.stringify({ path: p, content: f.content })),
      };
    }

    case "list_files": {
      const list = ctx.getFiles().map((f) => ({ path: f.name, size: f.content.length }));
      return {
        ok: true,
        label: `Listé ${list.length} fichiers`,
        content: JSON.stringify({ files: list }),
      };
    }

    case "write_file": {
      const p = String(args.path || "").trim();
      const content = typeof args.content === "string" ? args.content : "";
      if (!p) {
        return { ok: false, label: "write_file sans path", content: JSON.stringify({ error: "path required" }) };
      }
      // Reject placeholder leaks: weak models sometimes write the literal
      // words "FULL CONTENT" instead of real code.
      const trimmedContent = content.trim();
      const isPlaceholder =
        /^(FULL[_\s-]?CONTENT|FULL[_\s-]?FILE[_\s-]?CONTENT|<file[_\s-]?content>|\.\.\.)$/i.test(
          trimmedContent,
        );
      if (isPlaceholder) {
        return {
          ok: false,
          label: `write_file refusé (placeholder) ${p}`,
          content: JSON.stringify({
            error:
              "You wrote the placeholder string instead of real file content. Retry write_file with the ACTUAL complete code for this file — never the words 'FULL CONTENT'.",
          }),
        };
      }
      ctx.onWriteFile(p, content);
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("lovable:agent-file-write", { detail: { path: p } }),
        );
      }
      return {
        ok: true,
        label: `Écrit ${p} (${content.length} c.)`,
        content: JSON.stringify({ ok: true, path: p, bytes: content.length }),
      };
    }

    case "rename_file": {
      const from = String(args.from || "").trim();
      const to = String(args.to || "").trim();
      if (!from || !to) {
        return {
          ok: false,
          label: "rename_file invalide",
          content: JSON.stringify({ error: "from and to required" }),
        };
      }
      ctx.onRenameFile(from, to);
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("lovable:agent-file-write", { detail: { path: `${from} → ${to}` } }),
        );
      }
      return {
        ok: true,
        label: `Renommé ${from} → ${to}`,
        content: JSON.stringify({ ok: true, from, to }),
      };
    }

    case "delete_file": {
      const p = String(args.path || "").trim();
      if (!p) {
        return { ok: false, label: "delete_file sans path", content: JSON.stringify({ error: "path required" }) };
      }
      ctx.onDeleteFile(p);
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("lovable:agent-file-write", { detail: { path: `🗑 ${p}` } }),
        );
      }
      return {
        ok: true,
        label: `Supprimé ${p}`,
        content: JSON.stringify({ ok: true, path: p }),
      };
    }

    case "exec_shell": {
      const command = String(args.command || "").trim();
      if (!command) {
        return {
          ok: false,
          label: "exec_shell sans commande",
          content: JSON.stringify({ error: "command required" }),
        };
      }
      const r = await runnerCall<{
        exitCode: number;
        stdout: string;
        stderr: string;
        timedOut: boolean;
      }>("/api/exec", {
        projectId: ctx.projectId,
        command,
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
      });
      if (!r.ok) {
        return {
          ok: false,
          label: `Shell échec: ${command.slice(0, 40)}`,
          content: JSON.stringify({ error: r.error }),
        };
      }
      return {
        ok: r.data.exitCode === 0,
        label: `$ ${command.slice(0, 50)}${command.length > 50 ? "…" : ""} (exit ${r.data.exitCode})`,
        content: clip(JSON.stringify(r.data)),
      };
    }

    case "http_fetch": {
      const url = String(args.url || "").trim();
      if (!/^https?:\/\//i.test(url)) {
        return {
          ok: false,
          label: "http_fetch URL invalide",
          content: JSON.stringify({ error: "valid http(s) url required" }),
        };
      }
      const r = await runnerCall<{
        status: number;
        statusText: string;
        body: string;
      }>("/api/http-fetch", {
        url,
        method: args.method,
        headers: args.headers,
        body: args.body,
      });
      if (!r.ok) {
        return {
          ok: false,
          label: `HTTP échec: ${url}`,
          content: JSON.stringify({ error: r.error }),
        };
      }
      return {
        ok: true,
        label: `HTTP ${r.data.status} ${url}`,
        content: clip(JSON.stringify(r.data)),
      };
    }

    case "web_search": {
      const q = String(args.query || "").trim();
      if (!q) {
        return {
          ok: false,
          label: "web_search vide",
          content: JSON.stringify({ error: "query required" }),
        };
      }
      try {
        const r = await fetch("/api/web-search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: q }),
        });
        const j = await r.json();
        return {
          ok: true,
          label: `🔎 « ${q} » (${(j.results || []).length} résultats)`,
          content: clip(JSON.stringify(j)),
        };
      } catch (e) {
        return {
          ok: false,
          label: `Search échec: ${q}`,
          content: JSON.stringify({ error: e instanceof Error ? e.message : "search failed" }),
        };
      }
    }

    case "finish": {
      return {
        ok: true,
        label: "✓ Terminé",
        content: JSON.stringify({ ok: true, summary: args.summary || "" }),
      };
    }

    default:
      return {
        ok: false,
        label: `Outil inconnu: ${call.name}`,
        content: JSON.stringify({ error: `unknown tool ${call.name}` }),
      };
  }
}
