# wardroom × pi — the multi-agent harness inside pi

This extension puts wardroom's whole multi-agent capability inside a
[pi](https://pi.dev) session. Pi is the harness: it spawns and supervises
the headless crew (Claude Code, Codex, ...) on the current checkout, takes
your conductor orders, and controls the crew live. The wardroom CLI is not
involved — `wardroom.json` and the `.memo/` state files are the only shared
ground.

## Install

```bash
npm install wardroom          # in your project (also provides the engine)
mkdir -p .pi/extensions
cp node_modules/wardroom/integrations/pi/wardroom-pi.ts .pi/extensions/
```

pi loads extensions via jiti — no build step. Put a `wardroom.json` at the
repo root (roster of agent CLIs, conductor, review policy); the starter one
from the wardroom repo works as-is.

## Running a crew from pi

```
/crew start                    spawn the keep-alive crew from wardroom.json
/crew add a /login endpoint with JWT, and tests for it
                               anything that isn't a subcommand is a conductor
                               order -> live board tasks, dispatched to the crew
/crew status                   who is doing what right now
/crew log                      task lifecycle + crosstalk since you last looked
/crew hire claude-2            add an agent mid-run (vendor preset inferred; persisted)
/crew drop codex               stand one down (finishes in-flight work first)
/crew stop                     drain, stand down, writedown receipt
/board  /crosstalk  /stats     the shared board, crew mail, parallelism report
```

The crew is stood down automatically when the pi session shuts down, so no
claims are orphaned.

## The pi session is also a crew seat

- **Tools** (`wardroom_context`, `wardroom_claim_next`, `wardroom_complete`
  / `wardroom_fail`, `wardroom_plan`, `wardroom_send` / `wardroom_inbox`,
  `wardroom_remember`): pi's own LLM can claim board tasks, delegate to the
  headless crew, answer questions, and propose crew memory.
- **Enforced leases**: pi's `tool_call` event **blocks** edits to files a
  crew agent holds a lease on — the refusal names the holder, reason, and
  expiry. Enforcement, not advisory.
- **Injected brief**: every pi turn carries the crew protocol line and the
  verified Project Brief (crew memory).

Set `WARDROOM_AGENT` to name the pi seat (defaults to `pi`).

## Status

Working skeleton, written against pi-mono main as of 2026-07 (extensions
API: [docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)).
The engine (session/pool/conductor via `wardroom/harness`) and the tool +
guard layers use documented, stable surfaces; context injection and command
output are written defensively (`appendSystemPrompt` falling back to
`systemPrompt`, `ctx.print` falling back to `ctx.ui.notify`) and may need a
one-line adjustment as pi's API evolves. The full flow — `/crew start`,
conductor dispatch to parallel workers, status/board, the lease guard
blocking an edit, `/crew stop` with receipt — is exercised end to end
against a scripted mock of the pi API; a live pi install has not been
tested yet.
