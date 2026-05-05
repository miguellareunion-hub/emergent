import { useCallback, useEffect, useRef, useState } from "react";
import {
  type FileNode,
  type Project,
  getProject,
  languageFromName,
  uid,
  upsertProject,
} from "@/lib/projects";

export function useProject(projectId: string | undefined) {
  const [project, setProject] = useState<Project | null>(null);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const projectRef = useRef<Project | null>(null);

  useEffect(() => {
    if (!projectId) {
      projectRef.current = null;
      setLoaded(true);
      return;
    }
    const p = getProject(projectId);
    projectRef.current = p ?? null;
    if (p) {
      setProject(p);
      setActiveFileId(p.files[0]?.id ?? null);
    }
    setLoaded(true);
  }, [projectId]);

  const persist = useCallback((updater: Project | ((current: Project | null) => Project | null)) => {
    const base = projectRef.current;
    const next = typeof updater === "function" ? updater(base) : updater;
    if (!next) return;
    projectRef.current = next;
    upsertProject(next);
    setProject(next);
  }, []);

  const getLatestFiles = useCallback(() => projectRef.current?.files ?? [], []);

  const updateFile = useCallback(
    (fileId: string, content: string) => {
      persist((current) => {
        if (!current) return current;
        return {
          ...current,
          files: current.files.map((f) => (f.id === fileId ? { ...f, content } : f)),
        };
      });
    },
    [persist],
  );

  const createFile = useCallback(
    (name: string) => {
      const file: FileNode = {
        id: uid(),
        name,
        content: "",
        language: languageFromName(name),
      };

      persist((current) => {
        if (!current) return current;
        if (current.files.some((f) => f.name === name)) return current;
        return { ...current, files: [...current.files, file] };
      });
      setActiveFileId(file.id);
    },
    [persist],
  );

  const deleteFile = useCallback(
    (fileId: string) => {
      persist((current) => {
        if (!current) return current;
        const next: Project = { ...current, files: current.files.filter((f) => f.id !== fileId) };
        if (activeFileId === fileId) setActiveFileId(next.files[0]?.id ?? null);
        return next;
      });
    },
    [persist, activeFileId],
  );

  const renameFile = useCallback(
    (fileId: string, newName: string) => {
      persist((current) => {
        if (!current) return current;
        if (current.files.some((f) => f.name === newName && f.id !== fileId)) return current;
        return {
          ...current,
          files: current.files.map((f) =>
            f.id === fileId ? { ...f, name: newName, language: languageFromName(newName) } : f,
          ),
        };
      });
    },
    [persist],
  );

  const renameProject = useCallback(
    (name: string) => {
      persist((current) => (current ? { ...current, name } : current));
    },
    [persist],
  );

  /**
   * Apply an agent action by file path (creates the file if missing,
   * overwrites otherwise). Used by the AI agent to autonomously edit
   * the project.
   */
  const writeFileByPath = useCallback(
    (path: string, content: string) => {
      const normalizedPath = path.trim();
      const newFileId = uid();

      persist((current) => {
        if (!current) return current;
        const existing = current.files.find((f) => f.name === normalizedPath);
        if (existing) {
          return {
            ...current,
            files: current.files.map((f) =>
              f.id === existing.id ? { ...f, content } : f,
            ),
          };
        }

        return {
          ...current,
          files: [
            ...current.files,
            {
              id: newFileId,
              name: normalizedPath,
              content,
              language: languageFromName(normalizedPath),
            },
          ],
        };
      });

      setActiveFileId((currentId) => currentId ?? newFileId);
    },
    [persist],
  );

  const renameFileByPath = useCallback(
    (from: string, to: string) => {
      persist((current) => {
        if (!current) return current;
        const fromName = from.trim();
        const toName = to.trim();
        const f = current.files.find((x) => x.name === fromName);
        if (!f) return current;
        if (current.files.some((x) => x.name === toName && x.id !== f.id)) return current;
        return {
          ...current,
          files: current.files.map((x) =>
            x.id === f.id ? { ...x, name: toName, language: languageFromName(toName) } : x,
          ),
        };
      });
    },
    [persist],
  );

  const deleteFileByPath = useCallback(
    (path: string) => {
      persist((current) => {
        if (!current) return current;
        const targetName = path.trim();
        const f = current.files.find((x) => x.name === targetName);
        if (!f) return current;
        const next: Project = { ...current, files: current.files.filter((x) => x.id !== f.id) };
        if (activeFileId === f.id) setActiveFileId(next.files[0]?.id ?? null);
        return next;
      });
    },
    [persist, activeFileId],
  );

  return {
    project,
    loaded,
    activeFileId,
    setActiveFileId,
    updateFile,
    createFile,
    deleteFile,
    renameFile,
    renameProject,
    writeFileByPath,
    renameFileByPath,
    deleteFileByPath,
    getLatestFiles,
  };
}
