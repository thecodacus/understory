import { useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import ReactMarkdown from "react-markdown";
import { authHeaders } from "../api";
import type { AppConfig } from "../api";

const WRITE_TOOLS = new Set(["write_concept", "patch_concept", "delete_concept"]);

/**
 * Chat with the same agent the MCP server runs. Tool calls render inline —
 * watching which tools fire on which files is how we test the agent.
 */
export function ChatPanel({
  config,
  onMutation,
  onOpenConcept,
}: {
  config: AppConfig | null;
  onMutation: () => void;
  onOpenConcept: (path: string) => void;
}) {
  const [input, setInput] = useState("");
  const [provider, setProvider] = useState<string | undefined>(undefined);
  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      headers: () => authHeaders(),
      body: () => ({ provider }),
    }),
    onFinish: () => onMutation(), // refresh browse pane; agent may have written files
  });

  const busy = status === "submitted" || status === "streaming";

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <span className="text-sm font-semibold text-zinc-300">Agent chat</span>
        {config && (
          <select
            value={provider ?? config.defaultProvider}
            onChange={(e) => setProvider(e.target.value)}
            className="ml-auto rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-300"
          >
            {config.providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 && (
          <p className="p-4 text-sm text-zinc-500">
            Test the knowledge agent here — ask a question, or tell it something worth
            remembering. Tool calls show inline so you can watch it work.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "text-right" : ""}>
            {m.parts.map((part, i) => {
              if (part.type === "text") {
                return (
                  <div
                    key={i}
                    className={`markdown inline-block max-w-[95%] rounded-xl px-3 py-2 text-left text-sm ${
                      m.role === "user" ? "bg-cyan-900/50" : "bg-zinc-900 border border-zinc-800"
                    }`}
                  >
                    <ReactMarkdown>{part.text}</ReactMarkdown>
                  </div>
                );
              }
              if (part.type.startsWith("tool-")) {
                const toolName = part.type.slice(5);
                const p = part as unknown as {
                  state: string;
                  input?: Record<string, unknown>;
                  output?: unknown;
                };
                const filePath =
                  typeof p.input?.path === "string" ? (p.input.path as string) : undefined;
                return (
                  <div
                    key={i}
                    className={`my-1 flex items-center gap-2 rounded-lg border px-2 py-1 font-mono text-xs ${
                      WRITE_TOOLS.has(toolName)
                        ? "border-amber-800/60 bg-amber-950/30 text-amber-300"
                        : "border-zinc-800 bg-zinc-900/60 text-zinc-400"
                    }`}
                  >
                    <span>{p.state === "output-available" ? "✓" : "…"}</span>
                    <span className="font-semibold">{toolName}</span>
                    {filePath && (
                      <button
                        onClick={() => onOpenConcept(filePath)}
                        className="truncate text-cyan-400 hover:underline"
                      >
                        {filePath}
                      </button>
                    )}
                    {!filePath && typeof p.input?.query === "string" && (
                      <span className="truncate text-zinc-500">"{String(p.input.query)}"</span>
                    )}
                  </div>
                );
              }
              return null;
            })}
          </div>
        ))}
        {busy && <div className="animate-pulse text-xs text-zinc-500">agent working…</div>}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim() || busy) return;
          sendMessage({ text: input });
          setInput("");
        }}
        className="border-t border-zinc-800 p-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask or teach the knowledge base…"
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-cyan-600"
        />
      </form>
    </div>
  );
}
