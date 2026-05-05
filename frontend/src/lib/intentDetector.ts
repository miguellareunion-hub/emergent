/**
 * Detects whether a user prompt is a TARGETED MODIFICATION on an existing
 * project, or a fresh CREATION request.
 *
 * Goal: when the user says "ajoute un bouton X", "corrige Y", "modifie Z",
 * we must NOT let the Builder rewrite the whole project from scratch.
 */

export type Intent = "modify" | "create";

const MODIFY_KEYWORDS = [
  // FR
  "modifie", "modifier", "change", "changer", "ajoute", "ajouter",
  "supprime", "supprimer", "enleve", "enlève", "retire", "retirer",
  "corrige", "corriger", "répare", "repare", "réparer", "reparer",
  "fix", "amélioration", "améliore", "ameliore", "améliorer", "ameliorer",
  "renomme", "renommer", "déplace", "deplace",
  "remplace", "remplacer", "mets", "met à jour", "met a jour",
  "actualise", "actualiser", "patch",
  // EN
  "modify", "update", "add", "remove", "delete", "rename",
  "replace", "tweak", "adjust", "edit", "change",
  "improve", "refactor",
];

const CREATE_KEYWORDS = [
  "crée", "créer", "cree", "creer", "génère", "genere", "génère-moi",
  "build", "create", "make", "generate",
  "nouveau projet", "new project", "from scratch", "à partir de zéro",
  "recommence", "restart", "redo entirely",
];

/**
 * @param prompt    user message
 * @param hasFiles  true if the project already contains files
 */
export function detectIntent(prompt: string, hasFiles: boolean): Intent {
  const p = prompt.trim().toLowerCase();

  // Empty project => always creation
  if (!hasFiles) return "create";

  // Strong creation signals override everything
  for (const kw of CREATE_KEYWORDS) {
    if (p.startsWith(kw) || p.includes(` ${kw} `)) return "create";
  }

  // Any modification keyword present => modify
  for (const kw of MODIFY_KEYWORDS) {
    if (p.includes(kw)) return "modify";
  }

  // Default for non-empty project: short prompts (< 80 chars) are usually
  // tweaks; long ones are usually new features = treat as modify too,
  // because the project already exists.
  return "modify";
}

/**
 * Extra system instruction injected when intent === "modify".
 * Tells the Builder to behave like a careful patcher, not a re-generator.
 */
export const MODIFY_GUARD_PROMPT = `# ⚠️ MODE MODIFICATION (CRITICAL)
The user is asking for a TARGETED CHANGE on an EXISTING project. You MUST NOT rewrite the whole project.

Hard rules:
1. **Touch the MINIMUM number of files.** Re-emit ONLY the files that strictly need to change to fulfill the request.
2. **DO NOT re-emit unchanged files.** Every <lov-write> you produce on a file that didn't need to change is a bug — it costs tokens, breaks user customizations, and hides the real diff.
3. **DO NOT delete files** that the request didn't explicitly ask to remove. Never use <lov-delete> as part of a "cleanup" unless the user asked.
4. **Preserve the existing architecture** (filenames, module style, framework choices, naming conventions). Adapt to it; don't impose a new one.
5. **Keep variable names, IDs, classes, and exported APIs stable** — other files depend on them.
6. When you write a file, output its COMPLETE updated content (full file), but only for files you actually modify.
7. Briefly state at the top: "Modification ciblée : <1-line summary>" before any <lov-write>.

If the request is ambiguous, ask ONE clarifying question instead of rewriting everything.`;
