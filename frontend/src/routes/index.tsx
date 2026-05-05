import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { FolderPlus, Code2, Trash2, ArrowRight, Sparkles } from "lucide-react";
import {
  type Project,
  createStarterProject,
  deleteProject,
  loadProjects,
  upsertProject,
} from "@/lib/projects";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Lovable IDE — Build, edit, preview in your browser" },
      {
        name: "description",
        content:
          "An in-browser IDE with file explorer, code editor, live preview, terminal and an AI coding agent.",
      },
      { property: "og:title", content: "Lovable IDE" },
      {
        property: "og:description",
        content: "Build, edit, and preview HTML/CSS/JS projects right in your browser.",
      },
    ],
  }),
  component: HomePage,
});

function HomePage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    setProjects(loadProjects());
  }, []);

  const create = (n?: string) => {
    const finalName = (n ?? name).trim() || "Untitled Project";
    const p = createStarterProject(finalName);
    upsertProject(p);
    navigate({ to: "/ide/$projectId", params: { projectId: p.id } });
  };

  const remove = (id: string) => {
    if (!confirm("Delete this project? This cannot be undone.")) return;
    deleteProject(id);
    setProjects(loadProjects());
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Code2 className="h-4 w-4" />
            </div>
            <span className="text-lg font-semibold">Lovable IDE</span>
          </div>
          <a
            href="https://docs.lovable.dev"
            target="_blank"
            rel="noreferrer"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Docs
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-12">
        <section className="mb-12 text-center">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
            <Sparkles className="h-3 w-3 text-primary" />
            Code, preview, and chat with an AI agent — all in one tab
          </div>
          <h1 className="text-balance text-4xl font-bold tracking-tight md:text-5xl">
            Your in-browser <span className="text-primary">development</span> environment
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-pretty text-muted-foreground">
            Spin up an HTML/CSS/JS project, edit files in a Monaco editor, see changes live, and
            ask the built-in AI coding agent for help.
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
            className="mx-auto mt-8 flex max-w-lg gap-2"
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name your new project…"
              className="flex-1 rounded-md border border-border bg-input px-4 py-2.5 text-sm outline-none focus:border-primary"
            />
            <button
              type="submit"
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
            >
              <FolderPlus className="h-4 w-4" />
              Create
            </button>
          </form>
        </section>

        <section>
          <div className="mb-4 flex items-end justify-between">
            <h2 className="text-lg font-semibold">Your projects</h2>
            <span className="text-xs text-muted-foreground">
              {projects.length} {projects.length === 1 ? "project" : "projects"}
            </span>
          </div>

          {projects.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center">
              <p className="text-sm text-muted-foreground">
                No projects yet. Create your first one above to get started.
              </p>
              <button
                onClick={() => create("My First Project")}
                className="mt-4 inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:border-primary"
              >
                <FolderPlus className="h-4 w-4" /> Use a starter
              </button>
            </div>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((p) => (
                <li
                  key={p.id}
                  className="group rounded-lg border border-border bg-card p-4 transition hover:border-primary"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-semibold">{p.name}</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {p.files.length} files · updated{" "}
                        {new Date(p.updatedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <button
                      onClick={() => remove(p.id)}
                      className="rounded p-1 text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:bg-muted hover:text-destructive"
                      title="Delete"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <Link
                    to="/ide/$projectId"
                    params={{ projectId: p.id }}
                    className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                  >
                    Open <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      <footer className="mx-auto max-w-6xl px-6 pb-10 text-center text-xs text-muted-foreground">
        Built with TanStack Start, Monaco, and Lovable AI.
      </footer>
    </div>
  );
}
