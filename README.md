# understory 🌱

**Memory that grows.**

The layer beneath your agents: a self-wiring, plain-markdown memory. Every fact your agents learn is filed as a markdown concept, cross-linked into a living knowledge graph, and kept healthy by the agent itself — searchable, diffable, and entirely yours. Runs great on local models.

Bundles follow the [Open Knowledge Format (OKF) v0.1 spec](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) — plain markdown files with YAML frontmatter, readable by humans, diffable in git, portable across tools.

**Three ways in, one agent:**

- **MCP server** — `memory_query` / `memory_add` / `memory_update` / `memory_status` / `memory_maintain` tools over stdio or streamable HTTP. Each call drives an internal LLM agent with the OKF spec in its system prompt.
- **Web UI** — browse the bundle (tree, concept viewer, update log, conformance badge), see the memory as an Obsidian-style **force-directed graph** (drag/pan/zoom, colored by type, sized by connections, orphans ringed red, click to open), and chat with the same agent to test it. Tool calls render inline so you can watch it work.
- **Query-path replay** — every agent run (query/mutation/chat) records its traversal (searches → reads → writes) as a compact notation, persisted under `<bundle>/.traces/`. The graph view lists recent runs; selecting one replays the path as numbered directed hops over the graph — visited concepts ringed, search hits dotted, everything else faded.
- **CLI** — `pnpm agent:query "..."` / `pnpm agent:mutate "..."` smoke entries.

**Design rule: conformance is enforced in code, not prompts.** The deterministic bundle layer validates frontmatter (`type` required), regenerates `index.md` files, appends `log.md` entries (newest-first, spec §7), and sandboxes all paths to the bundle root. The LLM decides *what* to change; the code guarantees the result is a conformant bundle.

## Quick start (Docker)

No clone needed — the image is public. Save this as `docker-compose.yml`:

```yaml
services:
  understory:
    image: ghcr.io/thecodacus/understory:latest
    ports:
      - "3800:3800"
    volumes:
      # Your memory lives here as plain markdown — a named volume, or point
      # a bind mount (e.g. ./my-memory:/bundle) at any OKF bundle.
      - understory-memory:/bundle
    environment:
      BUNDLE_ROOT: /bundle
      # Pick ONE provider:
      # 1) Local llama.cpp / llama-swap (model auto-discovered; start llama-server with --jinja)
      LLM_PROVIDER: llamacpp
      LLAMACPP_BASE_URL: http://your-inference-box:8080
      # 2) Anthropic
      #LLM_PROVIDER: anthropic
      #ANTHROPIC_API_KEY: sk-ant-...
      # 3) OpenRouter
      #LLM_PROVIDER: openrouter
      #OPENROUTER_API_KEY: sk-or-...
    restart: unless-stopped

volumes:
  understory-memory:
```

```bash
docker compose up -d
```

Then:

- **Web UI** → http://localhost:3800 — browse the memory, watch the graph, chat with the agent
- **MCP endpoint** → `http://localhost:3800/mcp` (streamable HTTP) — register it in any MCP client:
  ```bash
  claude mcp add --transport http ustory http://localhost:3800/mcp
  ```
- Your agent now has `memory_query` / `memory_add` / `memory_update` / `memory_status` / `memory_maintain`, and gets a seed overview of the memory at every session start.

Teach it something (`memory_add`: "We deploy on Fridays, never Mondays"), then open the graph and watch the concept wire itself in. Deploying with Portainer? Use [docker-compose.portainer.yml](docker-compose.portainer.yml) as a repository stack.

## Stack

pnpm monorepo:

| Package | What |
|---|---|
| `packages/core` | OKF bundle layer (zero LLM) + agent (Vercel AI SDK tool loop: search/read/list/write/patch/delete) + provider registry |
| `packages/server` | Express: MCP streamable-HTTP at `/mcp`, stdio bin, REST browse API at `/api/*`, streaming chat at `/api/chat`, serves the web build |
| `packages/web` | Vite + React + TS + Tailwind: bundle browser + agent chat (`useChat`) |

Providers (env-selected, swappable per chat): **Anthropic** (default), **OpenRouter**, **llamacpp** (llama.cpp `llama-server` / llama-swap — model auto-discovered from `/v1/models`, loaded model preferred), **local** (any other OpenAI-compatible endpoint).

### llama.cpp

```bash
# on the inference box — --jinja enables OpenAI-style tool calling
llama-server -m model.gguf --jinja --host 0.0.0.0 --port 8080

# here — no model id needed, it's discovered
LLM_PROVIDER=llamacpp LLAMACPP_BASE_URL=http://inference-box:8080 \
BUNDLE_ROOT=./sample-bundle node packages/server/dist/index.js
```

Works behind llama-swap too: discovery prefers the currently **loaded** model so a query doesn't trigger a multi-minute model swap. Pin a specific model with `LLM_MODEL=`.

## From source

```bash
pnpm install
pnpm build
cp .env.example .env   # add your API key

BUNDLE_ROOT=./sample-bundle ANTHROPIC_API_KEY=sk-... node packages/server/dist/index.js
# → http://localhost:3800  (web UI + /api + /mcp)
```

Or build the container yourself: `docker compose up --build` (the repo's [docker-compose.yml](docker-compose.yml) builds from source and mounts `./sample-bundle`).

Dev mode (server on :3800, Vite HMR on :5180 with proxy):

```bash
BUNDLE_ROOT=./sample-bundle pnpm --filter @understory/server dev
pnpm --filter @understory/web dev
```

## MCP registration (Claude Code / Desktop)

```bash
claude mcp add ustory \
  -e BUNDLE_ROOT=/path/to/your/bundle \
  -e ANTHROPIC_API_KEY=sk-... \
  -- node /path/to/understory/packages/server/dist/mcp/stdio.js
```

Or point an HTTP MCP client at `http://host:3800/mcp`.

### Auth

By default the server is open — fine on localhost or a trusted LAN. Before exposing it anywhere else, set `AUTH_TOKEN`:

```bash
AUTH_TOKEN=$(openssl rand -hex 24)
```

With it set, `/mcp` and `/api` require `Authorization: Bearer <token>` (the web UI stays reachable and prompts for the token). Register authenticated MCP clients with a header:

```bash
claude mcp add --transport http ustory http://host:3800/mcp \
  --header "Authorization: Bearer <token>"
```

The stdio transport needs no token — it's a local process spawned by the client.

### Seed memory

A client LLM that only sees four bare tool names never gets the instinct to check memory. So at **session start** the server injects a compact overview of what the knowledge base contains (directories, concepts with types + descriptions, recent activity) through both channels that reach the model:

1. the MCP initialize **`instructions`** field (clients like Claude put it in the system prompt), and
2. the **`memory_query` tool description** — the universal fallback every tool-calling client loads.

The seed regenerates fresh for every new session. After `memory_add` / `memory_update` in a long-lived (stdio) session, the tool description refreshes via `tools/list_changed`, so the session sees its own writes. Out-of-band edits (hand edits, other clients) are picked up on the next session.

### Graph health & maintenance

Memory is a graph, not a pile of notes, and graphs rot: concepts go **orphaned** (nothing links to them) and links go **broken**. Two mechanisms keep it healthy:

- **Write-time linking** — new knowledge either enriches the concept it belongs to (an attribute of an existing entity is patched in, not filed separately) or, when it's a distinct entity, is created *and* back-linked from related concepts. Contradictions are superseded in place, never left standing alongside the old value.
- **`memory_maintain`** — a deterministic lint (orphans + broken links, surfaced in `memory_status` under `graph`) drives an internal agent to wire orphans into related concepts and fix dangling links. Run it periodically to counter drift; it's a no-op when the graph is already healthy.

This design mirrors the pattern in Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) (index.md + log.md, create-vs-enrich, lint for orphans). Deferred from that pattern until scale warrants: an explicit page-type schema, and hybrid FTS5+embedding search (the naive scan in `search.ts` is fine into the low thousands of concepts).

## Tests

```bash
pnpm test                                  # core: 18 tests (spec §5/§6/§7/§9, sandbox, search, concurrency)
pnpm --filter @understory/server exec tsx scripts/mcp-smoke.mts   # MCP stdio round-trip (needs SMOKE_BUNDLE + an API key)
```

## Environment

See [.env.example](.env.example). `BUNDLE_ROOT` is required; `GIT_AUTOCOMMIT=true` commits every mutation.
