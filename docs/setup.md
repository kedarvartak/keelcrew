# Setup & Wiring Guide

## Install

```bash
cd /path/to/multi-agent-memo
npm install

# make the entry point executable
chmod +x src/index.ts
```

## Wire into Claude Code

**Step 1 — Register the MCP server.** Add to your project's `.claude/settings.json`:

```json
{
  "mcpServers": {
    "multi-agent-memo": {
      "command": "node",
      "args": ["/path/to/multi-agent-memo/src/index.ts"]
    }
  }
}
```

**Step 2 — Auto-inject memory via hook.** Claude Code runs `UserPromptSubmit` hooks before every prompt. Add this to `.claude/settings.json` alongside the MCP config:

```json
{
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

The script reads the last 30 messages from `AGENTS.md` and wraps them in `<agent_memory>` tags. Claude sees this context before every message — no tool call required.

**Step 3 — Add `CLAUDE.md` to your project.** Copy the `CLAUDE.md` from this repo into your project root. Claude Code auto-loads it and the instructions tell Claude to write back to memory after completing work.

## Wire into Codex

Codex CLI **natively reads `AGENTS.md`** at the project root before every session — no extra config needed for memory injection. Just register the MCP server so Codex can write back to it:

Add to `~/.codex/config.json`:

```json
{
  "mcpServers": {
    "multi-agent-memo": {
      "command": "node",
      "args": ["/path/to/multi-agent-memo/src/index.ts"]
    }
  }
}
```

Since Codex reads `AGENTS.md` natively, it will always see the full shared log automatically. It still uses the MCP tools to append new entries.

## Wire into Gemini CLI

**Step 1 — Register the MCP server.** Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "multi-agent-memo": {
      "command": "node",
      "args": ["/path/to/multi-agent-memo/src/index.ts"]
    }
  }
}
```

**Step 2 — Add `GEMINI.md` to your project.** Gemini CLI auto-loads `GEMINI.md` from the project root. Copy the `GEMINI.md` from this repo — it instructs Gemini to call `get_context` first and `append_message` after completing work.

## Usage Pattern

At the start of every session, whichever agent you open first should call:

```
start_session(repo_path="/your/project", agent="claude", persona="architect")
```

Then for every message exchange:

```
append_message(repo_path="/your/project", agent="claude", persona="architect", speaker="claude", message="I scaffolded the auth module.")
append_message(repo_path="/your/project", agent="claude", persona="architect", speaker="me", message="Good. Add refresh token support.")
```

To pick up context when switching agents:

```
get_context(repo_path="/your/project", last_n=20)
```

The `AGENTS.md` file will be created automatically at the root of your project repo on first write.

## Available Tools

| Tool | Purpose |
|------|---------|
| `start_session` | Open a new session block (call once per working session) |
| `append_message` | Write one message line (agent or user) |
| `read_memory` | Read full log, optionally filter by agent |
| `get_context` | Get last N messages for context injection |
| `search_memory` | Search recent or historical memory by keyword and optional tag |
| `summarize_session` | Summarize a session into participants, decisions, blockers, and todos |
| `get_decisions` | Extract only decision-type entries from memory |

## Tags

You can add inline tags directly in `append_message` content:

```text
#decision
#blocker
#todo
```

Example:

```text
append_message(repo_path="/your/project", agent="codex", persona="coder", speaker="me", message="Use Redis for persistence. #decision")
```
