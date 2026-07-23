# Why parallel agents at all

> The honest case for wardroom. Most coding work is best done by one agent.
> This doc pins down exactly where a communicating crew on one checkout wins,
> why spawned subagents and worktrees do not cover those cases, and what we
> build to make each case undeniable. This is the product thesis; the
> landscape evidence behind it is in [differentiation.md](differentiation.md)
> and [parallelism.md](parallelism.md).

---

## 1. Where the skeptic is right

For deep, focused work — one feature, one module, tightly coupled logic — a
single agent beats a crew. Coherence is worth more than concurrency: one
context that holds the whole design will out-code two contexts that each hold
half and must talk. And for parallel *read* work (research, review, "search
the codebase five ways"), single-vendor subagent spawning already exists and
works: hub-and-spoke, results flow up to one parent brain, no coordination
protocol needed.

If wardroom's pitch were "any task, but parallel," it would lose to both.
The pitch is narrower and stronger.

## 2. Tree vs bus

Subagent spawning is a **tree**: results flow up, workers never talk to each
other. A tree is optimal when subtask outputs compose only at the root —
which is exactly what read-heavy work is.

Wardroom is a **bus**: a shared board plus directed messages; peers
coordinate laterally. A bus earns its coordination overhead only when
outputs must compose *with each other* mid-flight — which is precisely what
shared-checkout *writes* are: shared types, renamed endpoints, moved files.

That is the one-sentence answer to "why does this exist": trees for reads,
a bus for writes.

## 3. The four use cases wardroom lives for

### 3.1 Cross-vendor (the structural case)

Spawned subagents are always one vendor, one API key, one bill, one set of
strengths and rate limits. Real developers hold a Claude subscription *and*
a Codex/ChatGPT subscription. Wardroom is the only shape where both work
the same checkout at once. That buys three things:

- **Quota parallelism.** Two flat subscriptions, two independent rate
  limits — roughly double the fire-and-forget throughput at zero marginal
  cost.
- **Model arbitrage.** The strongest model plans and reviews; the cheaper
  or faster model grinds through implementation.
- **Honest diversity.** A *different* model reviewing catches error classes
  that correlated self-review misses. Cross-model review is structurally
  better review.

### 3.2 Broad-shallow write work (the workload case)

Subagents parallelize reads; writes are where they collide. Worktrees
isolate writes but defer the cost to merge time, where context is worst.
Wardroom's file leases make disjoint-footprint writes safe on one tree.

The workload that fits exactly: migrations, framework upgrades, lint and
type-error sweeps, test backfilling, i18n extraction, dead-code removal —
dozens of near-independent tasks over disjoint files. Wide, not deep. This
is a real, recurring, dreaded category of work, and it is the one where
"N agents, one board, one checkout" is straightforwardly the right tool.

### 3.3 Communication as continuous integration

Why peer communication at all, versus just spawning workers? Spawned
workers are blind to each other, which is fine when their outputs do not
interact. On one shared checkout they *do* interact. `post_event` and
`send_message` are how the merge tax gets paid continuously in small
increments instead of all at once at the end.

Communication is not the feature. **Integration without a merge step** is
the feature; communication is its mechanism.

### 3.4 Durable fire-and-forget

A single agent's session state dies with its context window. Wardroom's
board, messages, leases, and change records are durable files under
`.memo/`. A run survives restarts, rate-limit stalls, and overnight walls;
each agent re-syncs by reading state rather than being re-prompted.
Long-horizon autonomy needs externalized coordination state; a lone agent
has nowhere to put it.

## 4. What we build to make these undeniable

Ranked by how directly each strengthens a use case above.

### 4.1 The sweep primitive (for 3.2)

`wardroom sweep "<instruction>" --per <directory|glob>` — expand one
instruction into N disjoint-footprint tasks and let the whole crew drain
the queue. Turns the best-fit workload into a one-liner and gives the
project its marquee demo: "fix all 400 type errors across 3 agents, watch
the board drain."

### 4.2 Cross-vendor failover and quota-aware routing (for 3.1)

When one vendor rate-limits mid-run, its pending tasks re-route to the
other roster agents, and back when it recovers. Route grunt tasks to the
cheap model by default; reserve the strong model for planning and review.
Nobody else does this because nobody else is cross-vendor. It is also the
most practical pitch: the run does not stall at 2am because one provider
throttled.

### 4.3 Live event push into running agents (for 3.3)

Today peers hear about an API rename only between tasks. Lease renewal
should also deliver fresh events into the running task's context — feasible
mid-task for Claude Code via stream-json stdin; injected at the next task
boundary for one-shot CLIs like Codex exec. This makes "continuous
integration" true mid-task, not just between tasks.

### 4.4 Divergent attempts (for 3.1's diversity)

For a hard task, dispatch the *same* task to both models against isolated
scratch branches; the supervisor reviews both diffs and lands the winner.
Model diversity as a deliberate feature, not an accident.

### 4.5 Supervisor mode (the brain on top)

A `role: supervisor | implementor` split in `wardroom.json`. The supervisor
never claims implementation tasks; it runs a resident loop — plan, dispatch,
watch events, answer questions within seconds, review completions, convert
rejected reviews into fix-up tasks assigned back with notes. Implemented as
one persistent Claude Code process (stream-json stdin held open) so it keeps
the whole run's intent in a single clean context: plans, diffs, and
questions, while implementors burn their context on file contents. Context
isolation, more than raw concurrency, is why supervisor/implementor beats
one big agent.

## 5. Positioning

Not "parallel agents." Rather: **two subscriptions, one checkout, work
that is wide rather than deep, and a run that keeps integrating and keeps
going while you are not looking.**
