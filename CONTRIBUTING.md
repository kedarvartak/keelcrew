# Contributing to wardroom

Thanks for considering a contribution. This is a small, opinionated project;
the notes below keep changes easy to review and land.

## Ground rules

- Read [docs/why-parallel.md](docs/why-parallel.md) first — it is the
  product thesis. Features that fight it (web UIs, worktree isolation,
  approval gates on every edit) will be declined; the project is a
  single-terminal, fire-and-forget, shared-checkout harness by design.
- Docs are PM-grade prose: no emojis, no marketing filler.
- Be excellent to each other: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Security issues go through [SECURITY.md](SECURITY.md), never public
  issues.

## Development setup

```bash
git clone https://github.com/kedarvartak/wardroom
cd wardroom && npm install
npm test          # Node 22 native test runner
npm run build     # TypeScript -> dist/
```

Node 22+ is required. Tests run the `.ts` sources directly via
`--experimental-strip-types`; internal imports use explicit `.ts`
extensions (rewritten to `.js` at build time) — follow that convention.

## Making changes

1. Branch from `main`; never commit to `main` directly.
2. Every push gets its own pull request. Sequential work stacks PRs
   (branch B off branch A) rather than piling commits onto one branch.
3. Add or update tests for behavior changes — concurrency-sensitive code
   (store, claims, tasks, messages) has multi-process tests; keep them
   passing and add one if you touch atomicity.
4. Keep the working state honest: if a test fails, say so in the PR rather
   than papering over it.

## What makes a good PR

- One concern per PR, with the "why" in the description.
- New MCP tools or CLI commands come with a docs update
  ([docs/protocol.md](docs/protocol.md) or the README command table).
- No new runtime dependencies without discussion — the dependency surface
  is deliberately tiny (`@modelcontextprotocol/sdk`, `zod`).
