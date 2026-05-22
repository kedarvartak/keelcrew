# Claude — Agent Instructions

## Shared Memory

This project uses a shared memory log at `AGENTS.md`. All three agents (Claude, Codex, Gemini) write to and read from this file via the `multi-agent-memo` MCP server.

**Before making any change**, call:
```
get_context(repo_path="<this repo's absolute path>", last_n=30)
```

This gives you the last 30 messages from all agents so you don't repeat decisions or contradict earlier work.

**After completing work**, log what you did:
```
start_session(repo_path="...", agent="claude", persona="<your role>")
append_message(repo_path="...", agent="claude", persona="<your role>", speaker="claude", message="<what you did>")
```

## Why This Matters

Codex may have implemented something you're about to redesign. Gemini may have flagged a bug you're about to reintroduce. The memory log is the source of truth for cross-agent decisions.
