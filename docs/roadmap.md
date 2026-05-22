# Roadmap

## Phase 1 — Core MCP Server (current)

**Goal:** A working MCP server with basic read/write tools.

- [x] Project scaffold (`docs/`, `src/`, `package.json`)
- [x] `append_message` tool — write a message to the shared log
- [x] `read_memory` tool — read the full log or filter by agent/persona
- [x] `start_session` tool — open a new dated session block
- [x] `get_context` tool — return the last N messages for quick context injection
- [ ] Publish to npm as `multi-agent-memo`

## Phase 2 — Intelligence Layer

**Goal:** Make memory searchable and summarizable.

- [x] `search_memory` tool — keyword/semantic search across the log
- [x] `summarize_session` tool — compress a session into key decisions
- [x] `get_decisions` tool — extract only decision-type messages (not chatter)
- [x] Tag support: `#decision`, `#blocker`, `#todo` inline in messages

## Phase 3 — Agent Personas Registry

**Goal:** Codify what each agent/persona knows and does.

- [ ] `personas.json` config — define roles (coder, pm, reviewer, architect)
- [ ] Auto-inject persona context at session start
- [ ] Cross-agent handoff: `handoff_to` tool that packages context for the next agent

## Phase 4 — Remote Execution & Unified Orchestration

**Goal:** Dispatch prompts to Claude, Codex, and Gemini from a single interface. All three run remotely and their outputs land in shared memory — no manual copy-paste, no switching terminals.

### The Problem
Claude Code (`claude`), Codex CLI (`codex`), and Gemini CLI (`gemini`) each have non-interactive / headless execution modes, but they're invoked separately and their outputs go nowhere shared. There's no single place to say "all three, go."

### Architecture

```
User Prompt
     │
     ▼
 Orchestrator (new: src/orchestrator.ts)
     │
     ├──► claude -p "<prompt + context>"  ──► AGENTS.md (claude entry)
     ├──► codex exec "<prompt + context>" ──► AGENTS.md (codex entry)
     └──► gemini -p "<prompt + context>"  ──► AGENTS.md (gemini entry)
                                                   │
                                                   ▼
                                            Unified response
                                          assembled from memory
```

### New MCP Tools

- [ ] `dispatch` tool — send a prompt to one or more agents remotely; each agent runs headless, writes its output to `AGENTS.md`, returns when all complete
- [ ] `dispatch_parallel` tool — fire all three agents simultaneously with the same prompt; useful for "get all perspectives" tasks
- [ ] `dispatch_sequential` tool — fire agents in order, each receiving the previous agent's output as additional context (pipeline mode)
- [ ] `get_last_dispatch` tool — retrieve the outputs from the most recent dispatch as a unified diff

### Execution Adapters (`src/adapters/`)

Each CLI has its own headless invocation contract:

| Agent | Headless command | Output capture |
|-------|-----------------|----------------|
| Claude Code | `claude --print -p "<prompt>"` | stdout |
| Codex | `codex exec --quiet "<prompt>"` | stdout |
| Gemini CLI | `gemini -p "<prompt>"` | stdout |

Each adapter: (1) injects current `get_context()` into the prompt, (2) spawns the CLI as a child process, (3) captures stdout, (4) calls `append_message` to write the result into `AGENTS.md`.

### New Config (`agents.config.json`)

```json
{
  "agents": {
    "claude":  { "bin": "claude",  "args": ["--print", "-p"], "persona": "architect" },
    "codex":   { "bin": "codex",   "args": ["exec", "--quiet"], "persona": "coder" },
    "gemini":  { "bin": "gemini",  "args": ["-p"], "persona": "reviewer" }
  },
  "contextLines": 30
}
```

### Phase 4 Milestones

- [ ] `src/adapters/claude.ts` — Claude Code headless adapter
- [ ] `src/adapters/codex.ts` — Codex headless adapter
- [ ] `src/adapters/gemini.ts` — Gemini CLI headless adapter
- [ ] `src/orchestrator.ts` — fan-out dispatcher with parallel and sequential modes
- [ ] `dispatch` MCP tool wired into `src/index.ts`
- [ ] `agents.config.json` schema + validation
- [ ] Timeout + error handling per agent (one agent failure should not block others)
- [ ] `dispatch` output written to `AGENTS.md` with `dispatch_id` tag for traceability

## Phase 5 — Web UI & Hosted Interface

**Goal:** A browser-based interface that lets you dispatch prompts to all three agents from anywhere, watch responses stream in real time, and see the shared memory log update live. Deployed on a VPS — accessible from any device.

### Stack

| Layer | Choice | Why |
|-------|--------|-----|
| HTTP server | Fastify | Lightweight, first-class SSE support for streaming |
| Frontend | React + Vite | Fast dev loop, deploys as static files |
| Styling | Tailwind CSS | Utility-first, no design system overhead |
| Streaming | Server-Sent Events (SSE) | One-way server→browser stream, simpler than WebSockets for this use case |
| Tunnel | Cloudflare Tunnel (`cloudflared`) | Exposes local server at a stable public HTTPS URL — no VPS, no port-forwarding |
| UI hosting | Vercel / Netlify (free tier) | Static React app, your own domain |

### HTTP API (`src/server.ts`)

```
POST /dispatch
  body: { prompt: string, agents: string[], mode: "parallel" | "sequential" | "targeted", repo_path: string }
  response: { dispatch_id: string }

GET  /dispatch/:id/stream
  response: SSE stream — one event per agent output chunk

GET  /dispatch/:id
  response: { outputs: { claude?: string, codex?: string, gemini?: string }, status: "running" | "done" | "error" }

GET  /memory?repo_path=...
  response: full AGENTS.md content

GET  /memory/context?repo_path=...&last_n=30
  response: last N messages as JSON array
```

### UI Layout

```
┌─────────────────────────────────────────────────────────┐
│  multi-agent-memo                          [Memory Log]  │
├─────────────────────────────────────────────────────────┤
│  Prompt ________________________________________________ │
│         [claude ✓] [codex ✓] [gemini ✓]  [● Parallel ▾]│
│                                           [Dispatch →]   │
├───────────────┬────────────────┬───────────────────────┤
│ claude        │ codex          │ gemini                 │
│ architect     │ coder          │ reviewer               │
│               │                │                        │
│ Streaming...  │ Streaming...   │ Streaming...           │
│               │                │                        │
└───────────────┴────────────────┴───────────────────────┘
```

The memory log panel slides in from the right — full `AGENTS.md` rendered as Markdown, auto-scrolling to the latest entry as agents write.

### Phase 5 Milestones

- [ ] `src/server.ts` — Fastify HTTP server with `/dispatch`, `/dispatch/:id/stream`, `/memory` routes
- [ ] SSE streaming: each agent's stdout piped to a per-dispatch SSE channel
- [ ] `web/` — React + Vite frontend
  - [ ] Prompt input + agent selector + mode toggle
  - [ ] Three streaming response panels (one per agent)
  - [ ] Live memory log panel (polls or SSE)
  - [ ] Dispatch history list
- [ ] Auth: `MEMO_SECRET` env var checked on all API routes — prevents anyone else hitting your tunnel
- [ ] Cloudflare Tunnel setup: `cloudflared tunnel` config that exposes `localhost:3131` at a stable URL
- [ ] Web UI deployed to Vercel/Netlify as a static app with your own domain
- [ ] UI settings screen: input your tunnel URL + secret once, stored in `localStorage`
- [ ] `README.md` setup section: install CLIs → run local server → start tunnel → deploy UI → done
