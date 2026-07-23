# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately — do not open a public issue.

- Preferred: GitHub private vulnerability reporting on
  https://github.com/kedarvartak/wardroom/security/advisories
- Or email: kedarvartak01@gmail.com

Include reproduction steps and impact. You will get an acknowledgement
within a few days and a fix or mitigation plan before any public
disclosure.

## Supported versions

Only the latest published release receives security fixes.

## Threat model — what wardroom does and does not protect

Wardroom orchestrates coding-agent CLIs (Claude Code, Codex, Gemini) that
run with your local shell access and your credentials. Understand the
boundaries before running it unattended:

- **Agents execute code.** Wardroom spawns agent CLIs in fire-and-forget
  mode (for example `--permission-mode acceptEdits`). Anything those agents
  can do, a wardroom run can do. Run it in repositories you trust, review
  the per-task change records (`wardroom changes` / `show`), and prefer a
  sandboxed or containerized environment for untrusted work.
- **Prompt injection is inherited.** Instructions hidden in repository
  files, dependencies, or issue text can influence any coding agent
  wardroom drives. Wardroom does not add an approval gate by design;
  its mitigation is transparency (change records, event log, session
  writedowns), not prevention.
- **Coordination state is plain files.** Everything under `.memo/` (board,
  messages, leases, writedowns) is unencrypted local state and may contain
  code excerpts and task descriptions. Add `.memo/` to `.gitignore` if you
  do not want it committed, and treat it as sensitive as your source.
- **No network services.** Wardroom itself opens no ports; the MCP server
  speaks stdio only. All network traffic belongs to the underlying agent
  CLIs and their vendors.
- **File leases are advisory.** They coordinate cooperating agents; they
  are not a security boundary against a malicious process. The optional
  `wardroom guard` hook hardens interactive sessions but is still not a
  sandbox.

Vulnerabilities in the agent CLIs themselves should be reported to their
vendors (Anthropic, OpenAI, Google), not here.
