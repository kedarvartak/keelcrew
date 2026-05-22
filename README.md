<div align="center">

# multi-agent-memo

![npm](https://img.shields.io/npm/v/multi-agent-memo?style=flat-square&color=black)
![license](https://img.shields.io/npm/l/multi-agent-memo?style=flat-square&color=black)
![node](https://img.shields.io/node/v/multi-agent-memo?style=flat-square&color=black)
![mcp](https://img.shields.io/badge/MCP-compatible-black?style=flat-square)

<img src="https://github.com/kedarvartak/multi-agent-memo/blob/main/docs/banner.png" alt="multi-agent-memo" width="100%" />

**Shared memory MCP server for Claude Code, Codex, and Gemini CLI.**  
One append-only `AGENTS.md` in your repo. Every agent reads it. Every agent writes to it. No copy-paste. No cold starts.

</div>

---

## The Problem

Claude Code, Codex, and Gemini each start cold. They share no context — every session you re-explain decisions, re-describe architecture, and re-route work. The more agents you use, the worse it gets.

## How It Works

```
your project repo
└── AGENTS.md  ◄── single source of truth, versioned with your code

          ┌─────────────┐
          │  MCP Server │  (multi-agent-memo)
          └──────┬──────┘
                 │  tools/list, tools/call (stdio)
       ┌─────────┼─────────┐
       ▼         ▼         ▼
  Claude Code  Codex    Gemini CLI
  reads        reads    reads
  writes       writes   writes
       └─────────┬─────────┘
                 ▼
           AGENTS.md
```

Each CLI connects to the same MCP server. Before every session it reads recent context. After completing work it appends its output. All agents stay in sync automatically.

---

## Tools

| Tool | Purpose |
|------|---------|
| `start_session` | Open a dated session block for an `agent/persona` pair |
| `append_message` | Write one message line — agent or user |
| `read_memory` | Read full log, filter by `agent` or `persona` |
| `get_context` | Return last N messages as compact context lines |
| `search_memory` | Keyword search with optional `agent`, `persona`, `#tag` filters |
| `summarize_session` | Return participants, decisions, blockers, todos for a session |
| `get_decisions` | Extract decisions via `#decision` tags and heuristics |

### Inline Tags

Append tags anywhere in a message to mark its type:

| Tag | Meaning |
|-----|---------|
| `#decision` | A choice that was made and should not be revisited |
| `#blocker` | Something preventing progress |
| `#todo` | Work that still needs to happen |

---

## Memory Format

`AGENTS.md` is append-only, human-readable Markdown. Versioned header prevents newer-format files from being corrupted by older server versions.

```markdown
---
format: 1
project: my-repo
created: 2026-05-22
---

# Agent Memory

## Session: 2026-05-22

### codex — coder
**codex** — Implementing the refresh endpoint.
**me** — Use Redis for persistence. #decision
**codex** — Added ioredis dependency.

### gemini — reviewer
**gemini** — JWT refresh handling is blocked on test coverage. #blocker

### claude — architect
**me** — Document token expiry behavior. #todo
**claude** — Done, see docs/auth.md.
```

---

## Install

```bash
npm install -g multi-agent-memo
# or use without installing:
npx multi-agent-memo
```

Requires Node >= 22.

---

## Wiring

### Claude Code

Add to your project's `.claude/settings.json`:

```json
{
  "mcpServers": {
    "multi-agent-memo": {
      "command": "npx",
      "args": ["multi-agent-memo"]
    }
  },
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/multi-agent-memo/scripts/inject-memory.sh"
          }
        ]
      }
    ]
  }
}
```

The `UserPromptSubmit` hook injects the last 30 messages from `AGENTS.md` into every prompt automatically — no tool call needed.

Also copy `CLAUDE.md` from this repo into your project root. Claude Code auto-loads it.

### Codex

Codex CLI natively reads `AGENTS.md` at the project root — no extra config for memory injection. Register the MCP server for write-back:

```json
{
  "mcpServers": {
    "multi-agent-memo": {
      "command": "npx",
      "args": ["multi-agent-memo"]
    }
  }
}
```

### Gemini CLI

```json
{
  "mcpServers": {
    "multi-agent-memo": {
      "command": "npx",
      "args": ["multi-agent-memo"]
    }
  }
}
```

Copy `GEMINI.md` from this repo into your project root. Gemini CLI auto-loads it and follows the read-before/write-after pattern.

---

## How Memory Stays Visible

Different mechanism per CLI — same result: every agent sees the log before acting.

```
Claude Code  ──►  UserPromptSubmit hook injects last 30 messages before every prompt
Codex        ──►  reads AGENTS.md natively at session start
Gemini CLI   ──►  GEMINI.md instructs it to call get_context first
All three    ──►  MCP resource memo://agents-md available for proactive fetch
```

---

## Usage Pattern

```
1.  Start a session
    start_session(repo_path="/your/project", agent="claude", persona="architect")

2.  Log messages as you work
    append_message(..., speaker="claude", message="Scaffolded auth module under src/auth/.")
    append_message(..., speaker="me",     message="Add refresh token support. #todo")

3.  Switch agents — pick up context
    get_context(repo_path="/your/project", last_n=20)

4.  Search across history
    search_memory(repo_path="/your/project", query="Redis", filter_tag="decision")

5.  Summarize at end of session
    summarize_session(repo_path="/your/project")
```

---

## Development

```bash
git clone https://github.com/your-org/multi-agent-memo
cd multi-agent-memo
npm install

npm run build   # compile TypeScript → dist/
npm test        # run test suite (Node 22 native test runner)
npm start       # start MCP server over stdio
```

All 7 tests cover the full memory API: session lifecycle, filtering, search, decisions, and summarization.

---

## Roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| 1 — Core MCP | Done | `start_session`, `append_message`, `read_memory`, `get_context` |
| 2 — Intelligence | Done | `search_memory`, `summarize_session`, `get_decisions`, inline tags |
| 3 — Personas | Planned | `personas.json`, auto-inject persona context, `handoff_to` tool |
| 4 — Orchestration | Planned | Headless dispatch to all three CLIs, parallel and sequential modes |
| 5 — Web UI | Planned | Browser interface, Cloudflare Tunnel, streaming agent panels |

---

## License

MIT
