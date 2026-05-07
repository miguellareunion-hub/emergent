import { createFileRoute } from "@tanstack/react-router";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

/**
 * Built-in runner — executes shell commands in an isolated per-project workspace.
 *
 * The agent (browser-side) calls this endpoint via loadRunnerSettings().url + "/api/exec".
 * A shared token protects the endpoint. The workspace is materialised on disk
 * from the project files stored in the request body (since projects live in
 * the user's localStorage, not on the server).
 *
 * Security: arbitrary command execution is intentional — this IS the runner.
 * The token gate prevents random traffic, and the workspace is scoped to a
 * temporary directory per projectId.
 */

const RUNNER_TOKEN = process.env.RUNNER_TOKEN || "lovable-ide-local";
const BASE_WORKSPACE = process.env.WORKSPACES_DIR || path.join(os.tmpdir(), "lovable-runner");

try {
  fs.mkdirSync(BASE_WORKSPACE, { recursive: true });
} catch {
  /* ignore */
}

type ExecBody = {
  projectId?: string;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  /** Optional: full project file tree, synced before the command runs. */
  files?: Array<{ path: string; content: string }>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = (createFileRoute as any)("/api/exec")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const auth = request.headers.get("authorization") || "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (token !== RUNNER_TOKEN) {
          return json({ error: "Bad runner token" }, 401);
        }
        const body = (await request.json()) as ExecBody;
        const { projectId, command, cwd, timeoutMs, files } = body;
        if (!projectId || !command) {
          return json({ error: "projectId and command required" }, 400);
        }
        const safeId = String(projectId).replace(/[^a-zA-Z0-9_-]/g, "");
        if (!safeId) return json({ error: "invalid projectId" }, 400);
        const workdir = path.join(BASE_WORKSPACE, safeId);
        try {
          fs.mkdirSync(workdir, { recursive: true });
        } catch (e) {
          return json({ error: `mkdir failed: ${(e as Error).message}` }, 500);
        }

        // Sync files if provided
        if (Array.isArray(files)) {
          for (const f of files) {
            if (!f || typeof f.path !== "string") continue;
            const rel = f.path.replace(/^[/\\]+/, "");
            if (rel.includes("..")) continue;
            const target = path.join(workdir, rel);
            try {
              fs.mkdirSync(path.dirname(target), { recursive: true });
              fs.writeFileSync(target, f.content ?? "", "utf8");
            } catch {
              /* ignore individual file failures */
            }
          }
        }

        const runCwd = cwd
          ? path.join(workdir, String(cwd).replace(/^[/\\]+/, ""))
          : workdir;
        const timeout = Math.min(
          Math.max(typeof timeoutMs === "number" ? timeoutMs : 30000, 1000),
          120000,
        );

        return await new Promise<Response>((resolve) => {
          let stdout = "";
          let stderr = "";
          let settled = false;
          let timedOut = false;
          const proc = spawn("bash", ["-lc", command], {
            cwd: runCwd,
            env: { ...process.env, FORCE_COLOR: "0", CI: "1" },
          });
          const killTimer = setTimeout(() => {
            timedOut = true;
            try {
              proc.kill("SIGKILL");
            } catch {
              /* */
            }
          }, timeout);
          proc.stdout.on("data", (b) => {
            stdout += b.toString();
            if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
          });
          proc.stderr.on("data", (b) => {
            stderr += b.toString();
            if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
          });
          const done = (exitCode: number) => {
            if (settled) return;
            settled = true;
            clearTimeout(killTimer);
            resolve(
              json({
                exitCode,
                stdout,
                stderr,
                timedOut,
              }),
            );
          };
          proc.on("error", (e) => {
            stderr += `\nspawn error: ${e.message}`;
            done(1);
          });
          proc.on("exit", (code) => done(code ?? 1));
        });
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
