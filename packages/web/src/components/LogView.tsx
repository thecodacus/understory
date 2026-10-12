import { MarkdownRenderer } from "./MarkdownRenderer";
import type { LogEntry } from "../api";

const ACTION_STYLES: Record<LogEntry["action"], string> = {
  Creation: "bg-emerald-900/60 text-emerald-300",
  Update: "bg-cyan-900/60 text-cyan-300",
  Deletion: "bg-red-900/60 text-red-300",
};

export function LogView({
  entries,
  onNavigate,
}: {
  entries: LogEntry[];
  onNavigate: (path: string) => void;
}) {
  if (entries.length === 0) {
    return <p className="p-6 text-sm text-zinc-500">No log entries yet.</p>;
  }
  let lastDate = "";
  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-4 text-2xl font-bold">Update Log</h1>
      <div className="space-y-2">
        {entries.map((e, i) => {
          const showDate = e.date !== lastDate;
          lastDate = e.date;
          return (
            <div key={i}>
              {showDate && (
                <div className="mb-1 mt-4 text-sm font-semibold text-zinc-400">{e.date}</div>
              )}
              <div className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
                <span
                  className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${ACTION_STYLES[e.action]}`}
                >
                  {e.action}
                </span>
                <div className="markdown text-sm [&_p]:my-0">
                  <MarkdownRenderer
                    onNavigate={(href) => (href.startsWith("/") && href.endsWith(".md") ? href : null)}
                    onNavigateClick={onNavigate}
                  >
                    {e.summary}
                  </MarkdownRenderer>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
