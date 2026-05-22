# Multi-Agent Shared Memory — Idea

## The Problem

Claude Code, Codex, and Gemini CLI each operate in isolation. When you use all three on the same project, each agent starts cold — no memory of what another decided, built, or discussed. You end up re-explaining context, re-making decisions, and losing the thread of cross-agent work.

## The Solution

A single MCP server that maintains a **shared conversation log** inside the project repo (`AGENTS.md`). Every agent — Claude, Codex, Gemini — reads from and writes to this log through the MCP. The log is structured, human-readable Markdown.

## Log Format

```
## Session: 2026-05-22

### claude — architect
**claude** — I've scaffolded the auth module under `src/auth/`. Used JWT with refresh token rotation.
**me** — Good. Can you document the token expiry logic?
**claude** — Done, see `docs/auth.md`.

---

### codex — coder
**codex** — Implementing the refresh endpoint now. Should I use Redis or in-memory store?
**me** — Redis, we need persistence across restarts.
**codex** — Got it, adding `ioredis` dependency.

---

### gemini — junior developer 
**gemini** — handles small tasks
**me** — Fix it.
**gemini** — Fixed in commit `a3f9c2`.
```

## Key Properties

- **Append-only** — entries are never edited, only added. Full history is preserved.
- **Agent-tagged** — every entry knows which agent wrote it and what persona it was operating under.
- **Human-readable** — `AGENTS.md` is just Markdown. No database, no binary format.
- **MCP-native** — exposed as MCP tools so any compliant CLI can wire in with one config line.
- **Repo-local** — the memory file lives in the project, so it versions with the code.

## The Full Vision — Orchestration UI

Shared memory solves the context problem. But you still have to open three terminals, switch between them, and manually route work. The next layer removes that entirely.

The three CLIs run on your PC (where they're already installed and authenticated). A local HTTP server on the same machine spawns them as child processes and captures their output. A web UI — hosted at your own domain — talks to the local server through a **Cloudflare Tunnel**, giving it a stable public HTTPS URL without port-forwarding or a VPS.

From your browser, anywhere:
1. Type one prompt
2. Choose which agents to send it to (or all three at once)
3. Watch responses stream into side-by-side panels in real time
4. See `AGENTS.md` update live as each agent writes its output

```
Browser (your domain, anywhere)
      │
      │  POST /dispatch
      ▼
Cloudflare Tunnel  (stable public HTTPS URL → your PC)
      │
      ▼
Local HTTP Server (your PC, port 3131)
      │
      ├──► claude --print -p "..."  ──► stdout ──► AGENTS.md
      ├──► codex exec "..."         ──► stdout ──► AGENTS.md
      └──► gemini -p "..."          ──► stdout ──► AGENTS.md
                                           │
                          SSE stream ◄─────┘
                                           │
                                           ▼
                                  Browser panels update live
```

The web UI is a static React app — hosted on Vercel or Netlify for free. It stores your tunnel URL in settings (one-time setup). The local server is protected by a `MEMO_SECRET` token so only your UI can reach it.

### Dispatch Modes

- **Parallel** — all three agents get the same prompt simultaneously. Use for "review this", "what's wrong here", "give me options".
- **Sequential (pipeline)** — agents run in order, each receiving the previous agent's output as additional context. Example: Codex writes code → Claude reviews it → Gemini checks for regressions.
- **Targeted** — send to just one agent. Useful when you know exactly who should handle the task.

### What the UI Shows

- **Dispatch panel** — prompt input, agent selector, mode toggle (parallel / sequential / targeted)
- **Agent response panels** — one per agent, responses stream in as the CLI produces output
- **Memory log** — live view of `AGENTS.md`, updates as agents write entries
- **Dispatch history** — past dispatches with their outputs, filterable by agent or date

## Who This Is For

Developers who run multiple AI coding assistants on the same project and want them to share context, be dispatched together, and be managed from a single interface — without switching tools or re-explaining decisions.
