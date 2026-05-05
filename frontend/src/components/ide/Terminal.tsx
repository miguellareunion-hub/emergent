import { useEffect, useRef, useState } from "react";
import { Trash2, TerminalSquare } from "lucide-react";

export type ConsoleEntry = { level: string; msg: string; ts: number };

interface Props {
  entries: ConsoleEntry[];
  onClear: () => void;
  onCommand: (cmd: string) => string;
}

const colorFor = (level: string) => {
  switch (level) {
    case "error":
      return "text-red-400";
    case "warn":
      return "text-yellow-300";
    case "info":
      return "text-sky-300";
    case "debug":
      return "text-purple-300";
    case "system":
      return "text-emerald-300";
    case "input":
      return "text-foreground";
    default:
      return "text-foreground/90";
  }
};

export function Terminal({ entries, onClear, onCommand }: Props) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries.length]);

  return (
    <div className="flex h-full flex-col bg-[var(--terminal-bg)] font-mono text-xs">
      <div className="flex items-center justify-between border-b border-border bg-[var(--sidebar-bg)] px-3 py-1.5">
        <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <TerminalSquare className="h-3.5 w-3.5" /> Terminal
        </span>
        <button
          onClick={onClear}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Clear"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-auto px-3 py-2 leading-relaxed">
        {entries.length === 0 && (
          <p className="text-muted-foreground">
            Console output and commands will appear here. Try{" "}
            <span className="text-emerald-300">help</span>.
          </p>
        )}
        {entries.map((e, i) => (
          <div key={i} className={colorFor(e.level)}>
            <span className="opacity-50">
              [{new Date(e.ts).toLocaleTimeString([], { hour12: false })}]
            </span>{" "}
            <span className="opacity-70">{e.level}</span> · {e.msg}
          </div>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const cmd = input.trim();
          if (!cmd) return;
          onCommand(cmd);
          setInput("");
        }}
        className="flex items-center gap-2 border-t border-border bg-[var(--sidebar-bg)] px-3 py-2"
      >
        <span className="text-emerald-400">$</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a command (help, ls, clear, echo …)"
          className="flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
        />
      </form>
    </div>
  );
}
