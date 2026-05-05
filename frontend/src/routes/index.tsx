import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  FolderPlus,
  Code2,
  Trash2,
  ArrowRight,
  Sparkles,
  Zap,
  Bot,
  FileCode,
  Layers,
} from "lucide-react";
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
  const [withStarter, setWithStarter] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    setProjects(loadProjects());
  }, []);

  const create = (n?: string, starter?: boolean) => {
    const finalName = (n ?? name).trim() || "Untitled Project";
    const useStarter = starter ?? withStarter;
    const p = createStarterProject(finalName, "", useStarter);
    upsertProject(p);
    navigate({ to: "/ide/$projectId", params: { projectId: p.id } });
  };

  const remove = (id: string) => {
    if (!confirm("Supprimer ce projet ? Cette action est irréversible.")) return;
    deleteProject(id);
    setProjects(loadProjects());
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Soft gradient background accent */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 -z-10 h-[420px] bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/10 via-transparent to-transparent"
      />

      <header className="border-b border-border/60 backdrop-blur supports-[backdrop-filter]:bg-background/70 sticky top-0 z-10">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm shadow-primary/30">
              <Code2 className="h-4.5 w-4.5" />
            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-[15px] font-semibold tracking-tight">Lovable IDE</span>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                AI · Code · Preview
              </span>
            </div>
          </div>
          <a
            href="https://docs.lovable.dev"
            target="_blank"
            rel="noreferrer"
            className="text-sm text-muted-foreground transition hover:text-foreground"
          >
            Docs ↗
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-16">
        {/* Hero */}
        <section className="mb-16 text-center">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 px-3.5 py-1.5 text-xs font-medium text-primary">
            <Sparkles className="h-3 w-3" />
            Code · Preview · Chat with an AI agent — all in one tab
          </div>
          <h1 className="text-balance text-4xl font-bold tracking-tight md:text-6xl">
            Construis n'importe quoi avec{" "}
            <span className="bg-gradient-to-br from-primary to-primary/60 bg-clip-text text-transparent">
              une seule phrase
            </span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-pretty text-base text-muted-foreground md:text-lg">
            Décris ton projet à l'agent IA — il écrit le code, organise les
            fichiers et te montre le résultat en direct.
          </p>

          {/* Create form — sleek pill-shaped input */}
          <form
            data-testid="create-project-form"
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
            className="mx-auto mt-10 max-w-xl"
          >
            <div className="group relative rounded-2xl border border-border bg-card p-1.5 shadow-lg shadow-black/20 transition focus-within:border-primary/60 focus-within:shadow-primary/10">
              <div className="flex items-center gap-2">
                <div className="pl-3 text-muted-foreground">
                  <FolderPlus className="h-4 w-4" />
                </div>
                <input
                  data-testid="project-name-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Nom de ton projet (ex. trading-bot, portfolio…)"
                  className="flex-1 bg-transparent px-1 py-2.5 text-sm placeholder:text-muted-foreground/60 outline-none"
                />
                <button
                  type="submit"
                  data-testid="create-project-btn"
                  className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
                >
                  Créer
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Starter toggle */}
            <div className="mt-3.5 flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <label className="inline-flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  data-testid="with-starter-checkbox"
                  checked={withStarter}
                  onChange={(e) => setWithStarter(e.target.checked)}
                  className="h-3.5 w-3.5 cursor-pointer accent-primary"
                />
                <span>
                  Inclure les fichiers de démo (<code className="font-mono text-[11px] text-foreground/80">index.html</code> + CSS + JS)
                </span>
              </label>
            </div>
          </form>

          {/* Feature pills */}
          <div className="mx-auto mt-10 flex max-w-2xl flex-wrap items-center justify-center gap-2.5 text-[11px] text-muted-foreground">
            <Pill icon={<Bot className="h-3 w-3" />} label="Multi-agents Claude · GPT · Gemini" />
            <Pill icon={<Zap className="h-3 w-3" />} label="Live preview instantané" />
            <Pill icon={<FileCode className="h-3 w-3" />} label="Monaco editor" />
            <Pill icon={<Layers className="h-3 w-3" />} label="JSON · Node · HTML/CSS/JS" />
          </div>
        </section>

        {/* Projects */}
        <section>
          <div className="mb-5 flex items-end justify-between">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Tes projets</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Stockés localement dans ton navigateur — rien ne quitte ta machine.
              </p>
            </div>
            <span className="text-xs text-muted-foreground">
              {projects.length} {projects.length === 1 ? "projet" : "projets"}
            </span>
          </div>

          {projects.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card/40 p-12 text-center">
              <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-primary/10">
                <Sparkles className="h-5 w-5 text-primary" />
              </div>
              <p className="text-sm text-foreground">Aucun projet pour l'instant.</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Tape un nom ci-dessus, ou commence par un starter rapide.
              </p>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                <button
                  data-testid="empty-starter-btn"
                  onClick={() => create("Mon premier projet", false)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium transition hover:border-primary"
                >
                  <FolderPlus className="h-3.5 w-3.5" /> Projet vide
                </button>
                <button
                  data-testid="demo-starter-btn"
                  onClick={() => create("Mon premier projet", true)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90"
                >
                  <Sparkles className="h-3.5 w-3.5" /> Starter HTML/CSS/JS
                </button>
              </div>
            </div>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((p) => (
                <li
                  key={p.id}
                  data-testid={`project-card-${p.id}`}
                  className="group relative overflow-hidden rounded-xl border border-border bg-card p-5 transition hover:border-primary/60 hover:shadow-lg hover:shadow-primary/5"
                >
                  <div
                    aria-hidden
                    className="pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full bg-primary/10 opacity-0 blur-2xl transition group-hover:opacity-100"
                  />
                  <div className="relative flex items-start justify-between">
                    <div className="min-w-0">
                      <h3 className="truncate font-semibold">{p.name}</h3>
                      <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <FileCode className="h-3 w-3" />
                        {p.files.length} fichier{p.files.length !== 1 ? "s" : ""}
                        <span className="text-muted-foreground/40">·</span>
                        <span>{new Date(p.updatedAt).toLocaleDateString("fr-FR")}</span>
                      </p>
                    </div>
                    <button
                      onClick={() => remove(p.id)}
                      className="rounded p-1 text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                      title="Supprimer"
                      data-testid={`delete-project-${p.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <Link
                    to="/ide/$projectId"
                    params={{ projectId: p.id }}
                    data-testid={`open-project-${p.id}`}
                    className="relative mt-5 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                  >
                    Ouvrir <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      <footer className="mx-auto max-w-6xl px-6 pb-10 text-center text-xs text-muted-foreground">
        Built with TanStack Start · Monaco · Powered by Emergent LLM
      </footer>
    </div>
  );
}

function Pill({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/60 px-2.5 py-1">
      {icon}
      {label}
    </span>
  );
}
