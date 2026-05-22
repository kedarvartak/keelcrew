# Gemini — Agent Instructions

## Shared Memory

This project uses a shared memory log at `AGENTS.md`. Claude, Codex, and Gemini all read and write this file through the `multi-agent-memo` MCP server.

**Before making any change**, call:
```
get_context(repo_path="<this repo's absolute path>", last_n=30)
```

**After completing work**, log it:
```
start_session(repo_path="...", agent="gemini", persona="<your role>")
append_message(repo_path="...", agent="gemini", persona="<your role>", speaker="gemini", message="<what you did or decided>")
```

## Personas for This Project

Pick the persona that matches your task:
- `reviewer` — code review, catching bugs
- `junior developer` — small tasks, fixes, formatting
- `researcher` — looking things up, summarizing docs
