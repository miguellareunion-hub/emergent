import LZString from "lz-string";

const { compressToUTF16, decompressFromUTF16 } = LZString;

export type FileNode = {
  id: string;
  name: string;
  content: string;
  language: string;
};

export type Project = {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  files: FileNode[];
};

const STORAGE_KEY = "lovable-ide:projects";

export const languageFromName = (name: string): string => {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    json: "json",
    md: "markdown",
    py: "python",
    txt: "plaintext",
    svg: "xml",
    xml: "xml",
  };
  return map[ext] ?? "plaintext";
};

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export const loadProjects = (): Project[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];

    const decompressed = decompressFromUTF16(raw);
    if (decompressed) return JSON.parse(decompressed) as Project[];

    return JSON.parse(raw) as Project[];
  } catch {
    return [];
  }
};

export const saveProjects = (projects: Project[]) => {
  try {
    localStorage.setItem(STORAGE_KEY, compressToUTF16(JSON.stringify(projects)));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to save the project in browser storage.";
    throw new Error(`Project storage is full. Reduce file size or split the generation into smaller steps. ${message}`);
  }
};

export const getProject = (id: string): Project | undefined =>
  loadProjects().find((p) => p.id === id);

export const upsertProject = (project: Project) => {
  const all = loadProjects();
  const idx = all.findIndex((p) => p.id === project.id);
  project.updatedAt = Date.now();
  if (idx >= 0) all[idx] = project;
  else all.unshift(project);
  saveProjects(all);
};

export const deleteProject = (id: string) => {
  saveProjects(loadProjects().filter((p) => p.id !== id));
};

const STARTER_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>My App</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <main>
      <h1>Hello from your IDE 👋</h1>
      <p>Edit files on the left, see changes live on the right.</p>
      <button id="btn">Click me</button>
      <p id="count">0</p>
    </main>
    <script src="script.js"></script>
  </body>
</html>
`;

const STARTER_CSS = `* { box-sizing: border-box; }
body {
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto;
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #0f172a, #1e293b);
  color: #e2e8f0;
}
main { text-align: center; padding: 2rem; }
h1 { font-size: 2.25rem; margin: 0 0 .5rem; }
button {
  margin-top: 1rem;
  padding: .6rem 1.2rem;
  border-radius: .5rem;
  border: 1px solid #22c55e;
  background: #16a34a;
  color: white;
  cursor: pointer;
  font-weight: 600;
}
button:hover { background: #15803d; }
#count { font-size: 1.5rem; margin-top: .75rem; }
`;

const STARTER_JS = `const btn = document.getElementById("btn");
const count = document.getElementById("count");
let n = 0;
btn.addEventListener("click", () => {
  n += 1;
  count.textContent = String(n);
  console.log("clicked", n);
});
`;

/**
 * Create a brand-new project. By default the project is COMPLETELY EMPTY
 * (no files) so the AI agent can fully control the file structure when the
 * user asks for a custom build. Pass `withStarter: true` to seed the classic
 * HTML/CSS/JS demo files instead.
 */
export const createStarterProject = (
  name: string,
  description = "",
  withStarter = false,
): Project => ({
  id: uid(),
  name,
  description,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  files: withStarter
    ? [
        { id: uid(), name: "index.html", content: STARTER_HTML, language: "html" },
        { id: uid(), name: "style.css", content: STARTER_CSS, language: "css" },
        { id: uid(), name: "script.js", content: STARTER_JS, language: "javascript" },
      ]
    : [],
});

/**
 * Build a single self-contained HTML document for the iframe preview.
 * Inlines linked stylesheets and scripts referenced by simple relative paths.
 *
 * Looks for `index.html` at the project root first. If absent, falls back to
 * `public/index.html` (common in Node.js / Express projects where the static
 * frontend lives under public/).
 */
export const buildPreviewDoc = (files: FileNode[]): string => {
  const html =
    files.find((f) => f.name.toLowerCase() === "index.html") ??
    files.find((f) => f.name.toLowerCase() === "public/index.html");
  if (!html) {
    return `<!doctype html><html><body style="font-family:ui-sans-serif,system-ui;color:#94a3b8;background:#0a0e1a;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:380px;padding:24px">
  <div style="width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,#22c55e22,#22c55e11);display:grid;place-items:center;margin:0 auto 16px;border:1px solid #22c55e33">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
  </div>
  <h2 style="margin:0 0 8px;color:#e2e8f0;font-weight:600;font-size:18px">Aucun aperçu disponible</h2>
  <p style="margin:0;font-size:13px;line-height:1.5">Demandez à l'agent IA de créer un <code style="color:#22c55e;background:#22c55e15;padding:2px 6px;border-radius:4px;font-family:ui-monospace,monospace;font-size:12px">index.html</code> ou <code style="color:#22c55e;background:#22c55e15;padding:2px 6px;border-radius:4px;font-family:ui-monospace,monospace;font-size:12px">public/index.html</code> pour voir le rendu live.</p>
</div></body></html>`;
  }
  // Resolve sibling references relative to the html file's folder
  // e.g. for public/index.html, "style.css" resolves to "public/style.css".
  const folder = html.name.includes("/") ? html.name.replace(/\/[^/]+$/, "/") : "";
  let doc = html.content;

  // Replace <link rel="stylesheet" href="x.css"> with inline <style>
  doc = doc.replace(
    /<link\s+[^>]*href=["']([^"']+\.css)["'][^>]*>/gi,
    (_match, href: string) => {
      const candidates = [href, folder + href];
      const f = files.find((x) => candidates.includes(x.name));
      return f ? `<style>\n${f.content}\n</style>` : "";
    },
  );

  // Replace <script src="x.js"></script> with inline script
  doc = doc.replace(
    /<script\s+[^>]*src=["']([^"']+\.js)["'][^>]*>\s*<\/script>/gi,
    (_match, src: string) => {
      const candidates = [src, folder + src];
      const f = files.find((x) => candidates.includes(x.name));
      return f ? `<script>\n${f.content}\n<\/script>` : "";
    },
  );

  // Inject console bridge for terminal
  const bridge = `<script>(function(){
    const send = (level, args) => {
      try {
        const msg = args.map(a => {
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch { return String(a); }
        }).join(' ');
        parent.postMessage({ __ide_console: true, level, msg }, '*');
      } catch(e){}
    };
    ['log','info','warn','error','debug'].forEach(level => {
      const orig = console[level];
      console[level] = function(...args){ send(level, args); orig.apply(console, args); };
    });
    window.addEventListener('error', (e) => send('error', [e.message + ' (' + (e.filename||'') + ':' + (e.lineno||'') + ')']));
    window.addEventListener('unhandledrejection', (e) => send('error', ['Unhandled promise rejection: ' + (e.reason && e.reason.message || e.reason)]));
  })();<\/script>`;

  if (doc.includes("</head>")) doc = doc.replace("</head>", `${bridge}</head>`);
  else doc = bridge + doc;

  return doc;
};
