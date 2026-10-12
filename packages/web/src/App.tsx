import { useCallback, useEffect, useState } from "react";
import { api, ApiError, setAuthToken, type AppConfig, type Concept, type ConformanceReport, type LogEntry, type ProfileInfo, type SearchHit, type TreeNode } from "./api";
import { Tree } from "./components/Tree";
import { ConceptView } from "./components/ConceptView";
import { LogView } from "./components/LogView";
import { ChatPanel } from "./components/ChatPanel";
import { GraphView } from "./components/GraphView";

type View =
  | { kind: "concept"; path: string }
  | { kind: "log" }
  | { kind: "graph" }
  | { kind: "empty" };

export default function App() {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [report, setReport] = useState<ConformanceReport | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [view, setView] = useState<View>({ kind: "empty" });
  const [concept, setConcept] = useState<Concept | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [chatOpen, setChatOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<ProfileInfo["mode"] | null>(null);
  const [profile, setProfile] = useState<ProfileInfo | null>(null);

  const refresh = useCallback(() => {
    api
      .tree()
      .then((t) => {
        setTree(t);
        setNeedsToken(false);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) {
          setAuthMode(e.authMode ?? null);
          setNeedsToken(true);
        } else setError(String(e));
      });
    api.validate().then(setReport).catch(() => {});
    api.log().then(setLog).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    api.config().then(setConfig).catch(() => {});
    api.profile().then(setProfile).catch(() => {});
  }, [refresh]);

  // Everything on screen belongs to the memory the current key opens, so a
  // key change always starts from a clean page rather than patching state.
  const submitKey = useCallback(async (key: string) => {
    setAuthToken(key);
    try {
      await api.profile();
      window.location.reload();
    } catch (e) {
      setAuthToken("");
      setTokenError(
        e instanceof ApiError && e.status === 401 ? "That key was not accepted." : `Could not reach the server: ${String(e)}`
      );
    }
  }, []);

  const switchProfile = useCallback(() => {
    setAuthToken("");
    window.location.reload();
  }, []);

  useEffect(() => {
    if (view.kind === "concept") {
      api.concept(view.path).then(setConcept).catch((e) => setError(String(e)));
    }
  }, [view]);

  // Re-load the open concept (and graph) after chat mutations.
  const [graphRefreshKey, setGraphRefreshKey] = useState(0);
  const onMutation = useCallback(() => {
    refresh();
    setGraphRefreshKey((k) => k + 1);
    setView((v) => ({ ...v }));
  }, [refresh]);

  useEffect(() => {
    if (!query.trim()) {
      setHits(null);
      return;
    }
    const t = setTimeout(() => api.search(query).then(setHits).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [query]);

  const openConcept = useCallback((path: string) => {
    if (path === "/log.md") {
      setView({ kind: "log" });
    } else {
      setView({ kind: "concept", path });
    }
    setError(null);
    setQuery("");
  }, []);

  if (needsToken) {
    return (
      <div className="flex h-screen items-center justify-center">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setTokenError(null);
            void submitKey(tokenInput.trim());
          }}
          className="w-80 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5"
        >
          <h1 className="text-sm font-bold tracking-wide text-cyan-300">understory 🌱</h1>
          <p className="mt-2 text-sm text-zinc-400">
            {authMode === "profiles" ? (
              <>This server hosts several memories. Enter your profile's API key; it decides which memory opens.</>
            ) : authMode === "single" ? (
              <>
                This server requires an access token (its <code className="text-zinc-300">AUTH_TOKEN</code>).
              </>
            ) : (
              <>This server requires an access key.</>
            )}
          </p>
          {tokenError && <p className="mt-2 text-sm text-red-400">{tokenError}</p>}
          <input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder={authMode === "profiles" ? "Profile API key" : "Access token"}
            autoFocus
            className="mt-3 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-cyan-600"
          />
          <button
            type="submit"
            className="mt-3 w-full rounded-lg bg-cyan-700 px-3 py-2 text-sm font-medium text-white hover:bg-cyan-600"
          >
            Unlock
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-800">
        <div className="border-b border-zinc-800 p-3">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-bold tracking-wide text-cyan-300">understory 🌱</h1>
            {report && (
              <span
                title={`${report.conceptCount} concepts, ${report.issues.length} issues`}
                className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  report.conformant
                    ? "bg-emerald-900/60 text-emerald-300"
                    : "bg-red-900/60 text-red-300"
                }`}
              >
                {report.conformant ? "conformant" : "non-conformant"}
              </span>
            )}
          </div>
          {profile?.profile && (
            <div className="mt-2 flex items-center gap-2 text-xs">
              <span className="text-zinc-500">profile</span>
              <span className="truncate font-medium text-zinc-200" title={profile.profile}>
                {profile.profile}
              </span>
              <button
                onClick={switchProfile}
                title="Forget this key and open a different profile"
                className="ml-auto rounded px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              >
                switch
              </button>
            </div>
          )}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm outline-none focus:border-cyan-600"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {hits ? (
            <div className="space-y-1">
              {hits.length === 0 && <p className="px-2 text-xs text-zinc-500">No matches.</p>}
              {hits.map((h) => (
                <button
                  key={h.path}
                  onClick={() => openConcept(h.path)}
                  className="block w-full rounded px-2 py-1.5 text-left hover:bg-zinc-800"
                >
                  <div className="text-sm text-zinc-200">{h.title ?? h.path}</div>
                  {h.snippet && <div className="truncate text-xs text-zinc-500">{h.snippet}</div>}
                </button>
              ))}
            </div>
          ) : tree ? (
            <Tree
              node={tree}
              selected={view.kind === "concept" ? view.path : null}
              onSelect={openConcept}
            />
          ) : (
            <p className="px-2 text-xs text-zinc-500">Loading…</p>
          )}
        </div>

        <div className="flex border-t border-zinc-800 text-xs">
          <button
            onClick={() => setView({ kind: "log" })}
            className={`flex-1 px-3 py-2 hover:bg-zinc-800 ${view.kind === "log" ? "text-cyan-300" : "text-zinc-400"}`}
          >
            Log
          </button>
          <button
            onClick={() => setView({ kind: "graph" })}
            className={`flex-1 border-l border-zinc-800 px-3 py-2 hover:bg-zinc-800 ${view.kind === "graph" ? "text-cyan-300" : "text-zinc-400"}`}
          >
            Graph
          </button>
          <button
            onClick={() => setChatOpen(!chatOpen)}
            className="flex-1 border-l border-zinc-800 px-3 py-2 text-zinc-400 hover:bg-zinc-800"
          >
            {chatOpen ? "Hide chat" : "Chat"}
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className={`min-w-0 flex-1 ${view.kind === "graph" ? "overflow-hidden" : "overflow-y-auto"}`}>
        {error && <p className="p-6 text-sm text-red-400">{error}</p>}
        {!error && view.kind === "empty" && (
          <div className="flex h-full items-center justify-center text-zinc-600">
            <p>Select a concept, or ask the agent →</p>
          </div>
        )}
        {!error && view.kind === "concept" && concept && (
          <ConceptView concept={concept} onNavigate={openConcept} />
        )}
        {!error && view.kind === "log" && <LogView entries={log} onNavigate={openConcept} />}
        {!error && view.kind === "graph" && (
          <GraphView refreshKey={graphRefreshKey} onNavigate={openConcept} />
        )}
      </main>

      {/* Chat */}
      {chatOpen && (
        <aside className="w-96 shrink-0 border-l border-zinc-800">
          <ChatPanel config={config} onMutation={onMutation} onOpenConcept={openConcept} />
        </aside>
      )}
    </div>
  );
}
