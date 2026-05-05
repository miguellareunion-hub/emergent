/* eslint-disable no-console */
/**
 * Lovable IDE — Local Node Runner
 * --------------------------------
 * Run with:  RUNNER_TOKEN=secret npm start
 *
 * SECURITY: this server executes arbitrary code from the IDE (whatever the
 * project's package.json declares). Only run it on a trusted machine, behind
 * a token, and never expose it publicly without further protection.
 */

const express = require("express");
const cors = require("cors");
const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");
const { createProxyMiddleware } = require("http-proxy-middleware");

const PORT = parseInt(process.env.PORT || "7070", 10);
const TOKEN = process.env.RUNNER_TOKEN || "";
const WORKSPACES_DIR = path.resolve(process.env.WORKSPACES_DIR || "./workspaces");
const APP_PORT = parseInt(process.env.APP_PORT || "3000", 10);

if (!TOKEN) {
  console.warn("⚠️  RUNNER_TOKEN is empty. The runner will refuse all requests.");
  console.warn('    Start with:   RUNNER_TOKEN="some-secret" npm start');
}

fs.mkdirSync(WORKSPACES_DIR, { recursive: true });

/** projectId -> { proc, logs[], status, script, startedAt } */
const projects = new Map();
/** projectId -> Set<WebSocket> */
const sockets = new Map();

const app = express();
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: "25mb" }));

// --- auth -----------------------------------------------------------------
function checkAuth(req, res, next) {
  if (!TOKEN) return res.status(503).json({ error: "Runner has no token configured" });
  const h = req.headers.authorization || "";
  const provided = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (provided !== TOKEN) return res.status(401).json({ error: "Bad token" });
  next();
}

// --- helpers --------------------------------------------------------------
function safeProjectDir(projectId) {
  const safe = String(projectId).replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) throw new Error("Invalid projectId");
  return path.join(WORKSPACES_DIR, safe);
}

function broadcast(projectId, payload) {
  const set = sockets.get(projectId);
  if (!set) return;
  const msg = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function pushLog(projectId, level, line) {
  const entry = { level, line, ts: Date.now() };
  const p = projects.get(projectId);
  if (p) {
    p.logs.push(entry);
    if (p.logs.length > 2000) p.logs.splice(0, p.logs.length - 2000);
  }
  broadcast(projectId, { type: "log", ...entry });
}

async function writeFiles(dir, files) {
  await fsp.mkdir(dir, { recursive: true });
  for (const f of files) {
    if (!f || typeof f.path !== "string") continue;
    const rel = f.path.replace(/^[/\\]+/, "");
    // prevent path escape
    if (rel.includes("..")) continue;
    const target = path.join(dir, rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, f.content ?? "", "utf8");
  }
}

function killProject(projectId) {
  const p = projects.get(projectId);
  if (p && p.proc && !p.proc.killed) {
    try {
      // negative pid kills the whole group on POSIX (npm + child node)
      if (process.platform !== "win32") {
        try { process.kill(-p.proc.pid, "SIGTERM"); } catch (_) { p.proc.kill("SIGTERM"); }
        // hard-kill any survivor after 1.5s
        setTimeout(() => {
          try { process.kill(-p.proc.pid, "SIGKILL"); } catch (_) { /* gone */ }
        }, 1500);
      } else {
        p.proc.kill("SIGTERM");
      }
    } catch (e) {
      console.error("kill error", e);
    }
  }
}

// Best-effort: free APP_PORT by killing whatever still listens on it.
// Used between runs so a stuck `node server.js` from a previous project
// can't block the next `npm run dev` with EADDRINUSE.
function freePort(port) {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      // netstat + taskkill on Windows
      const ns = spawn("cmd", ["/c", `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do taskkill /F /PID %a`], { shell: false });
      ns.on("exit", () => resolve());
      ns.on("error", () => resolve());
      return;
    }
    // POSIX: try lsof, then fuser as fallback. Both may be missing — that's OK.
    const tryCmd = (cmd, args) => new Promise((res) => {
      const p = spawn(cmd, args, { shell: false });
      let out = "";
      p.stdout && p.stdout.on("data", (b) => { out += b.toString(); });
      p.on("error", () => res(""));
      p.on("exit", () => res(out.trim()));
    });
    (async () => {
      let pids = await tryCmd("lsof", ["-ti", `:${port}`]);
      if (!pids) {
        // fuser prints to stderr; just try and ignore output
        await tryCmd("fuser", ["-k", `${port}/tcp`]);
      } else {
        for (const pid of pids.split(/\s+/).filter(Boolean)) {
          try { process.kill(parseInt(pid, 10), "SIGKILL"); } catch (_) { /* */ }
        }
      }
      // small grace period so the kernel actually releases the socket
      setTimeout(resolve, 400);
    })();
  });
}

function runScript(projectId, dir, script) {
  killProject(projectId);

  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  // If script is "install" -> only install. Otherwise: install then run.
  const isInstallOnly = script === "install";
  const cmd = npmCmd;
  const args = isInstallOnly
    ? ["install", "--no-fund", "--no-audit", "--loglevel=error"]
    : ["run", script];

  const state = {
    proc: null,
    logs: [],
    status: "starting",
    script,
    startedAt: Date.now(),
  };
  projects.set(projectId, state);

  const startProc = (c, a, label) =>
    new Promise((resolve) => {
      pushLog(projectId, "system", `$ ${label}`);
      const proc = spawn(c, a, {
        cwd: dir,
        env: { ...process.env, FORCE_COLOR: "0", PORT: String(APP_PORT) },
        detached: process.platform !== "win32",
        shell: false,
      });
      state.proc = proc;
      proc.stdout.on("data", (b) => pushLog(projectId, "stdout", b.toString()));
      proc.stderr.on("data", (b) => pushLog(projectId, "stderr", b.toString()));
      proc.on("error", (e) => pushLog(projectId, "stderr", `spawn error: ${e.message}`));
      proc.on("exit", (code) => {
        pushLog(projectId, "system", `process exited with code ${code}`);
        resolve(code);
      });
    });

  (async () => {
    try {
      // free APP_PORT before doing anything: a survivor from a previous run
      // (e.g. an old `node server.js` from another project) would otherwise
      // crash the new dev server with EADDRINUSE.
      pushLog(projectId, "system", `freeing port ${APP_PORT}…`);
      await freePort(APP_PORT);

      // always install first if package.json exists
      const hasPkg = fs.existsSync(path.join(dir, "package.json"));
      if (hasPkg && !isInstallOnly) {
        state.status = "installing";
        broadcast(projectId, { type: "status", status: state.status });
        const code = await startProc(npmCmd, ["install", "--no-fund", "--no-audit", "--loglevel=error"], "npm install");
        if (code !== 0) {
          state.status = "error";
          broadcast(projectId, { type: "status", status: state.status });
          return;
        }
      }
      state.status = isInstallOnly ? "installing" : "running";
      broadcast(projectId, { type: "status", status: state.status });
      await startProc(cmd, args, `${cmd} ${args.join(" ")}`);
      state.status = "stopped";
      broadcast(projectId, { type: "status", status: state.status });
    } catch (e) {
      pushLog(projectId, "stderr", String(e?.message || e));
      state.status = "error";
      broadcast(projectId, { type: "status", status: state.status });
    }
  })();
}

// --- routes ---------------------------------------------------------------
app.get("/api/health", (_req, res) => res.json({
  ok: true,
  hasToken: !!TOKEN,
  // Advertise capabilities so the IDE knows which agent tools it can offer.
  capabilities: ["run", "stop", "sync", "exec", "read-file", "list-files", "http-fetch"],
}));

/**
 * Generic shell exec inside a project's workspace dir.
 * Body: { projectId, command: string, cwd?: string, timeoutMs?: number }
 * Returns: { exitCode, stdout, stderr, timedOut }
 */
app.post("/api/exec", checkAuth, async (req, res) => {
  try {
    const { projectId, command, cwd, timeoutMs } = req.body || {};
    if (!projectId || typeof command !== "string" || !command.trim()) {
      return res.status(400).json({ error: "projectId and command required" });
    }
    const dir = safeProjectDir(projectId);
    await fsp.mkdir(dir, { recursive: true });
    const finalCwd = cwd
      ? path.join(dir, String(cwd).replace(/^[/\\]+/, ""))
      : dir;
    if (!finalCwd.startsWith(dir)) {
      return res.status(400).json({ error: "cwd escapes workspace" });
    }
    const limit = Math.min(Math.max(parseInt(timeoutMs || "30000", 10), 1000), 120000);

    pushLog(projectId, "system", `$ (agent) ${command}`);

    const isWin = process.platform === "win32";
    const shellCmd = isWin ? "cmd.exe" : "bash";
    const shellArgs = isWin ? ["/c", command] : ["-lc", command];

    const proc = spawn(shellCmd, shellArgs, {
      cwd: finalCwd,
      env: { ...process.env, FORCE_COLOR: "0" },
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill("SIGKILL"); } catch (_) { /* */ }
    }, limit);

    proc.stdout.on("data", (b) => {
      const s = b.toString();
      stdout += s;
      pushLog(projectId, "stdout", s);
    });
    proc.stderr.on("data", (b) => {
      const s = b.toString();
      stderr += s;
      pushLog(projectId, "stderr", s);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      // Cap output sizes so we don't blow up the IDE
      const cap = (s) => (s.length > 20000 ? s.slice(0, 20000) + "\n…(truncated)" : s);
      res.json({
        ok: true,
        exitCode: code,
        stdout: cap(stdout),
        stderr: cap(stderr),
        timedOut,
      });
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      res.status(500).json({ error: String(e?.message || e) });
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/**
 * Read a file from the workspace.
 * Body: { projectId, path }
 */
app.post("/api/read-file", checkAuth, async (req, res) => {
  try {
    const { projectId, path: rel } = req.body || {};
    if (!projectId || typeof rel !== "string") {
      return res.status(400).json({ error: "projectId and path required" });
    }
    const dir = safeProjectDir(projectId);
    const target = path.join(dir, rel.replace(/^[/\\]+/, ""));
    if (!target.startsWith(dir)) return res.status(400).json({ error: "path escape" });
    const content = await fsp.readFile(target, "utf8");
    res.json({ ok: true, path: rel, content });
  } catch (e) {
    res.status(404).json({ error: String(e?.message || e) });
  }
});

/**
 * List files in the workspace (recursive, max 500).
 * Body: { projectId, dir?: string }
 */
app.post("/api/list-files", checkAuth, async (req, res) => {
  try {
    const { projectId, dir: subdir } = req.body || {};
    if (!projectId) return res.status(400).json({ error: "projectId required" });
    const root = safeProjectDir(projectId);
    const start = subdir
      ? path.join(root, String(subdir).replace(/^[/\\]+/, ""))
      : root;
    if (!start.startsWith(root)) return res.status(400).json({ error: "path escape" });

    const out = [];
    const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache"]);
    async function walk(d, rel) {
      if (out.length >= 500) return;
      let entries;
      try { entries = await fsp.readdir(d, { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        if (out.length >= 500) return;
        if (SKIP.has(e.name)) continue;
        const full = path.join(d, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          out.push({ path: r, type: "dir" });
          await walk(full, r);
        } else if (e.isFile()) {
          let size = 0;
          try { size = (await fsp.stat(full)).size; } catch (_) { /* */ }
          out.push({ path: r, type: "file", size });
        }
      }
    }
    await walk(start, "");
    res.json({ ok: true, files: out });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/**
 * HTTP test request from the runner machine. Useful for an agent to verify
 * its own running app responds correctly.
 * Body: { url, method?, headers?, body? }
 */
app.post("/api/http-fetch", checkAuth, async (req, res) => {
  try {
    const { url, method = "GET", headers = {}, body } = req.body || {};
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: "valid http(s) url required" });
    }
    const r = await fetch(url, { method, headers, body });
    const text = await r.text();
    const cap = text.length > 20000 ? text.slice(0, 20000) + "\n…(truncated)" : text;
    res.json({
      ok: true,
      status: r.status,
      statusText: r.statusText,
      headers: Object.fromEntries(r.headers.entries()),
      body: cap,
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/api/run", checkAuth, async (req, res) => {
  try {
    const { projectId, files, script = "dev" } = req.body || {};
    if (!projectId || !Array.isArray(files)) return res.status(400).json({ error: "projectId and files[] required" });
    const dir = safeProjectDir(projectId);
    await writeFiles(dir, files);
    runScript(projectId, dir, String(script));
    res.json({ ok: true, projectId, dir, previewUrl: `/preview/${projectId}/` });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/**
 * Hot-sync: write/update files in the project workspace WITHOUT restarting
 * the running process. Used by the IDE while the agent is editing code so
 * dev servers (vite, nodemon, next dev…) can hot-reload naturally.
 *
 * If the project isn't running yet, we still write the files (so the next
 * /api/run picks them up) and report "not_running" so the client knows.
 */
app.post("/api/sync", checkAuth, async (req, res) => {
  try {
    const { projectId, files } = req.body || {};
    if (!projectId || !Array.isArray(files)) {
      return res.status(400).json({ error: "projectId and files[] required" });
    }
    const dir = safeProjectDir(projectId);
    await writeFiles(dir, files);
    const p = projects.get(projectId);
    const running = !!(p && p.proc && !p.proc.killed);
    if (running) {
      pushLog(projectId, "system", `↻ hot-sync: ${files.length} fichier(s) mis à jour`);
    }
    res.json({ ok: true, synced: files.length, running, status: p?.status || "idle" });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/api/stop", checkAuth, (req, res) => {
  const { projectId } = req.body || {};
  if (!projectId) return res.status(400).json({ error: "projectId required" });
  killProject(projectId);
  const p = projects.get(projectId);
  if (p) {
    p.status = "stopped";
    broadcast(projectId, { type: "status", status: "stopped" });
  }
  res.json({ ok: true });
});

app.get("/api/status", checkAuth, (req, res) => {
  const { projectId } = req.query;
  if (!projectId) return res.status(400).json({ error: "projectId required" });
  const p = projects.get(String(projectId));
  res.json({ status: p?.status || "idle", script: p?.script, startedAt: p?.startedAt, logs: p?.logs?.slice(-200) || [] });
});

// Proxy /preview/:projectId/* -> http://localhost:APP_PORT/*
// (a single shared port; restart the project to switch)
app.use(
  "/preview/:projectId",
  createProxyMiddleware({
    target: `http://localhost:${APP_PORT}`,
    changeOrigin: true,
    ws: true,
    pathRewrite: (p, req) => p.replace(`/preview/${req.params.projectId}`, "") || "/",
    logLevel: "warn",
    onError: (err, _req, res) => {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Preview unavailable: ${err.message}\nIs the app running on port ${APP_PORT}?`);
    },
  })
);

// --- server + websocket ---------------------------------------------------
const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/ws") {
    // let the proxy handle it (preview ws)
    return;
  }
  const token = url.searchParams.get("token") || "";
  const projectId = url.searchParams.get("projectId") || "";
  if (!TOKEN || token !== TOKEN || !projectId) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.projectId = projectId;
    let set = sockets.get(projectId);
    if (!set) { set = new Set(); sockets.set(projectId, set); }
    set.add(ws);
    // send last buffered logs
    const p = projects.get(projectId);
    if (p) {
      ws.send(JSON.stringify({ type: "status", status: p.status }));
      for (const e of p.logs.slice(-200)) ws.send(JSON.stringify({ type: "log", ...e }));
    }
    ws.on("close", () => set.delete(ws));
  });
});

server.listen(PORT, () => {
  console.log(`▶ Lovable IDE runner listening on http://localhost:${PORT}`);
  console.log(`  workspaces dir: ${WORKSPACES_DIR}`);
  console.log(`  proxying user app from http://localhost:${APP_PORT} at /preview/:projectId/*`);
  if (!TOKEN) console.log("  ⚠️  RUNNER_TOKEN is empty — refusing all requests until set.");
});
