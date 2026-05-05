/**
 * Pre-run static validator for projects produced by the Builder agent.
 *
 * Goal: catch the most common silly mistakes BEFORE handing the project
 * to the runner, so we don't waste time on a `node` round-trip just to
 * discover an export name typo.
 *
 * The validator is intentionally lightweight — pure regex, no AST. It's
 * meant to flag obvious problems like:
 *   - import { foo } from "./bar.js"   // but bar.js doesn't export `foo`
 *   - import x from "./missing.js"     // missing.js doesn't exist
 *   - HTML <script src="app.js"> but app.js wasn't generated
 *
 * False negatives are fine; false positives would be harmful, so we only
 * report a problem when we are confident the file is clearly broken.
 */

import type { FileNode } from "@/lib/projects";

export type ValidationIssue = {
  file: string;
  line?: number;
  message: string;
  /** A single-line hint we can feed back into the Fixer prompt. */
  hint: string;
};

const IMPORT_RE =
  /^\s*import\s+(?:(\*\s+as\s+\w+)|(\w+)(?:\s*,\s*\{([^}]+)\})?|\{([^}]+)\})\s+from\s+["']([^"']+)["']/gm;

const EXPORT_NAMED_RE =
  /^\s*export\s+(?:const|let|var|function|class|async\s+function)\s+(\w+)/gm;
const EXPORT_NAMED_LIST_RE = /^\s*export\s*\{([^}]+)\}/gm;
const EXPORT_DEFAULT_RE = /^\s*export\s+default\b/m;

const SCRIPT_SRC_RE = /<script\b[^>]*\bsrc=["']([^"']+)["']/gi;
const LINK_HREF_RE = /<link\b[^>]*\bhref=["']([^"']+)["']/gi;

function findFile(files: FileNode[], path: string): FileNode | undefined {
  // Normalize: strip leading ./ and a single leading /
  const norm = path.replace(/^\.\/+/, "").replace(/^\/+/, "");
  return files.find((f) => f.name === norm || f.name === path);
}

function getExports(content: string): { named: Set<string>; hasDefault: boolean } {
  const named = new Set<string>();
  let m: RegExpExecArray | null;
  EXPORT_NAMED_RE.lastIndex = 0;
  while ((m = EXPORT_NAMED_RE.exec(content)) !== null) {
    named.add(m[1]);
  }
  EXPORT_NAMED_LIST_RE.lastIndex = 0;
  while ((m = EXPORT_NAMED_LIST_RE.exec(content)) !== null) {
    for (const raw of m[1].split(",")) {
      const part = raw.trim().split(/\s+as\s+/)[1] ?? raw.trim();
      const cleaned = part.trim();
      if (cleaned && cleaned !== "default") named.add(cleaned);
    }
  }
  return { named, hasDefault: EXPORT_DEFAULT_RE.test(content) };
}

function getLineOf(content: string, idx: number): number {
  return content.slice(0, idx).split("\n").length;
}

function isRelative(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/");
}

function resolveSpecifier(fromFile: string, spec: string): string {
  // Resolve relative to the importing file's directory.
  const fromDir = fromFile.includes("/") ? fromFile.replace(/\/[^/]+$/, "") : "";
  const joined = fromDir ? `${fromDir}/${spec.replace(/^\.\//, "")}` : spec.replace(/^\.\//, "");
  // collapse ../
  const parts: string[] = [];
  for (const p of joined.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") parts.pop();
    else parts.push(p);
  }
  return parts.join("/");
}

export function validateProject(files: FileNode[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byName = new Map(files.map((f) => [f.name, f]));

  for (const file of files) {
    if (!/\.(m?js|jsx|ts|tsx)$/i.test(file.name)) continue;
    const content = file.content;

    let m: RegExpExecArray | null;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(content)) !== null) {
      const [, namespaceImport, defaultImport, mixedNamed, namedOnly, spec] = m;
      if (!isRelative(spec)) continue; // skip bare specifiers (npm packages)

      const resolved = resolveSpecifier(file.name, spec);
      // Try resolved as-is, then with .js, then with /index.js
      const candidates = [resolved, `${resolved}.js`, `${resolved}.mjs`, `${resolved}/index.js`];
      const target = candidates.map((c) => byName.get(c)).find(Boolean);
      const line = getLineOf(content, m.index);

      if (!target) {
        issues.push({
          file: file.name,
          line,
          message: `Import target "${spec}" does not exist in the project.`,
          hint: `In ${file.name} (line ${line}), the import "${spec}" points to a file that was never written. Either create it with <lov-write> or remove the import.`,
        });
        continue;
      }

      const exp = getExports(target.content);

      if (defaultImport && !namespaceImport && !exp.hasDefault) {
        issues.push({
          file: file.name,
          line,
          message: `Default import "${defaultImport}" from "${spec}", but ${target.name} has no default export.`,
          hint: `In ${file.name}, "import ${defaultImport} from '${spec}'" expects a default export, but ${target.name} only exports: ${[...exp.named].join(", ") || "(nothing)"}. Either add "export default ..." in ${target.name}, or change the import to a named import.`,
        });
      }

      const namedList = (mixedNamed || namedOnly || "")
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);

      for (const name of namedList) {
        if (!exp.named.has(name)) {
          issues.push({
            file: file.name,
            line,
            message: `Named import "{ ${name} }" from "${spec}", but ${target.name} does not export it.`,
            hint: `In ${file.name}, "import { ${name} } from '${spec}'" expects a named export "${name}", but ${target.name} exports: ${[...exp.named].join(", ") || "(nothing named)"}${exp.hasDefault ? " plus a default export" : ""}. Add "export const ${name} = ..." (or "export function ${name}") in ${target.name}, or change the import to match an existing export.`,
          });
        }
      }
    }
  }

  // HTML <script src="..."> / <link href="..."> sanity check
  for (const file of files) {
    if (!/\.html?$/i.test(file.name)) continue;
    const content = file.content;
    let m: RegExpExecArray | null;
    SCRIPT_SRC_RE.lastIndex = 0;
    while ((m = SCRIPT_SRC_RE.exec(content)) !== null) {
      const src = m[1];
      if (/^https?:\/\//i.test(src)) continue;
      const resolved = resolveSpecifier(file.name, src.replace(/^\//, "./"));
      if (!byName.has(resolved) && !byName.has(src)) {
        issues.push({
          file: file.name,
          message: `<script src="${src}"> references a file that doesn't exist.`,
          hint: `${file.name} loads "${src}" but that file was never written. Create it with <lov-write path="${resolved}"> or remove the <script> tag.`,
        });
      }
    }
    LINK_HREF_RE.lastIndex = 0;
    while ((m = LINK_HREF_RE.exec(content)) !== null) {
      const href = m[1];
      if (/^https?:\/\//i.test(href)) continue;
      if (!/\.css$/i.test(href)) continue;
      const resolved = resolveSpecifier(file.name, href.replace(/^\//, "./"));
      if (!byName.has(resolved) && !byName.has(href)) {
        issues.push({
          file: file.name,
          message: `<link href="${href}"> references a stylesheet that doesn't exist.`,
          hint: `${file.name} links "${href}" but that file was never written.`,
        });
      }
    }
  }

  return issues;
}

/** Format issues into a single message block ready to feed the Fixer agent. */
export function formatIssuesForFixer(issues: ValidationIssue[]): string {
  return issues
    .map((i, idx) => `${idx + 1}. [${i.file}${i.line ? `:${i.line}` : ""}] ${i.message}\n   → ${i.hint}`)
    .join("\n");
}
