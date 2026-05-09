/**
 * Attachment handling for the AgentChat:
 *   - images  → kept as base64 data URLs and sent to the LLM as multimodal
 *               `image_url` parts (vision).
 *   - zip     → uploaded to the runner's /api/extract-zip endpoint, then
 *               every TEXT file inside is loaded into the project state via
 *               onWriteFile().
 *   - text    → raw UTF-8 content embedded inline in the prompt.
 */

import { loadRunnerSettings } from "@/lib/runnerSettings";

export type AttachmentKind = "image" | "zip" | "text" | "binary";

export type Attachment = {
  id: string;
  name: string;
  size: number;
  mime: string;
  kind: AttachmentKind;
  /** For images: base64 data URL. */
  dataUrl?: string;
  /** For text/code files: UTF-8 content. */
  text?: string;
  /** For zip: raw base64 (no data URL prefix), kept until upload. */
  zipBase64?: string;
};

export type ExtractedZipFile = {
  path: string;
  size: number;
  isText: boolean;
  content?: string;
};

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB / image
const MAX_ZIP_BYTES = 60 * 1024 * 1024; // 60MB / zip
const MAX_TEXT_BYTES = 1 * 1024 * 1024; // 1MB / text file

const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "json", "js", "mjs", "cjs", "ts", "tsx", "jsx",
  "html", "htm", "css", "scss", "sass", "less", "yml", "yaml", "toml", "ini",
  "env", "conf", "cfg", "xml", "svg", "csv", "tsv", "sh", "bash", "zsh",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "cpp", "h", "hpp", "cs",
  "php", "lua", "sql", "graphql", "gql", "vue", "svelte", "astro",
  "gitignore", "editorconfig", "dockerfile", "prettierrc", "eslintrc",
  "npmrc", "babelrc",
]);

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

export function isZipFile(file: File): boolean {
  return (
    file.type === "application/zip" ||
    file.type === "application/x-zip-compressed" ||
    file.name.toLowerCase().endsWith(".zip")
  );
}

export function detectKind(file: File): AttachmentKind {
  if (isImageFile(file)) return "image";
  if (isZipFile(file)) return "zip";
  if (file.type.startsWith("text/")) return "text";
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (TEXT_EXTS.has(ext)) return "text";
  return "binary";
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

export async function processFile(file: File): Promise<Attachment | { error: string }> {
  const kind = detectKind(file);
  if (kind === "image") {
    if (file.size > MAX_IMAGE_BYTES) {
      return { error: `Image trop lourde: ${file.name} (${humanSize(file.size)} > 8MB)` };
    }
    const dataUrl = await readAsDataUrl(file);
    return {
      id: cryptoRandomId(),
      name: file.name,
      size: file.size,
      mime: file.type,
      kind: "image",
      dataUrl,
    };
  }
  if (kind === "zip") {
    if (file.size > MAX_ZIP_BYTES) {
      return { error: `ZIP trop lourd: ${file.name} (${humanSize(file.size)} > 60MB)` };
    }
    const dataUrl = await readAsDataUrl(file);
    const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
    return {
      id: cryptoRandomId(),
      name: file.name,
      size: file.size,
      mime: file.type || "application/zip",
      kind: "zip",
      zipBase64: base64,
    };
  }
  if (kind === "text") {
    if (file.size > MAX_TEXT_BYTES) {
      return { error: `Fichier texte trop lourd: ${file.name} (${humanSize(file.size)} > 1MB)` };
    }
    const text = await readAsText(file);
    return {
      id: cryptoRandomId(),
      name: file.name,
      size: file.size,
      mime: file.type || "text/plain",
      kind: "text",
      text,
    };
  }
  return { error: `Type non supporté: ${file.name} (${file.type || "binaire"})` };
}

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export type ZipExtractionResult = {
  ok: boolean;
  error?: string;
  filename: string;
  totalEntries: number;
  strippedPrefix: string | null;
  files: ExtractedZipFile[];
};

/**
 * Upload a ZIP attachment to the runner so it gets extracted into the project
 * workspace. Returns the list of extracted files (with text content inlined
 * for files <256KB).
 */
export async function extractZipOnRunner(
  attachment: Attachment,
  projectId: string,
): Promise<ZipExtractionResult> {
  if (attachment.kind !== "zip" || !attachment.zipBase64) {
    return {
      ok: false,
      error: "Not a zip attachment",
      filename: attachment.name,
      totalEntries: 0,
      strippedPrefix: null,
      files: [],
    };
  }
  const s = loadRunnerSettings();
  if (!s.token) {
    return {
      ok: false,
      error:
        "Runner non configuré. Le runner local est requis pour extraire un ZIP.",
      filename: attachment.name,
      totalEntries: 0,
      strippedPrefix: null,
      files: [],
    };
  }
  const base = (s.url || "").replace(/\/+$/, "");
  try {
    const r = await fetch(`${base}/api/extract-zip`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${s.token}`,
      },
      body: JSON.stringify({
        projectId,
        zipBase64: attachment.zipBase64,
        filename: attachment.name,
      }),
    });
    const j = (await r.json()) as ZipExtractionResult & { error?: string };
    if (!r.ok || !j.ok) {
      return {
        ok: false,
        error: j.error || `HTTP ${r.status}`,
        filename: attachment.name,
        totalEntries: 0,
        strippedPrefix: null,
        files: [],
      };
    }
    return j;
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "network error",
      filename: attachment.name,
      totalEntries: 0,
      strippedPrefix: null,
      files: [],
    };
  }
}
