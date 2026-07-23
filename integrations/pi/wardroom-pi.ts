/* eslint-disable @typescript-eslint/no-explicit-any */
// ── wardroom inside pi: the multi-agent harness as a pi extension ─────────────
// Drop this file in `.pi/extensions/` (project) or `~/.pi/agent/extensions/`
// (global), with `wardroom` installed as a project dependency. Pi becomes the
// harness: it spawns and supervises the headless crew (Claude Code, Codex, …)
// on THIS checkout, takes conductor commands, and controls the crew live —
// no wardroom CLI involved.
//
//   /crew start [a,b]      spawn the keep-alive crew from wardroom.json
//   /crew <command>        conductor: turn an order into board tasks, dispatched live
//   /crew status | log     live pane summary | lifecycle + crosstalk since last look
//   /crew hire <name>      add an agent mid-run (vendor preset inferred, persisted)
//   /crew drop <name>      stand one down (finishes in-flight work first)
//   /crew stop             drain and stand the crew down (writedown receipt)
//   /board  /crosstalk     the shared board, recent crew mail
//
// The pi session itself is ALSO a crew seat: wardroom_* tools let pi's own
// LLM claim tasks and message the crew, the tool_call guard blocks edits to
// files a headless worker has leased, and the verified crew brief is injected
// into every turn.
//
// Written against the pi extension API as of pi-mono main (2026-07):
// https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md

import { Type } from "@sinclair/typebox";
import {
  checkFiles,
  claimNextTask,
  completeTask,
  crosstalk,
  failTask,
  getContext,
  getMessages,
  memoryBrief,
  planTasks,
  remember,
  renderBoard,
  renderStats,
  sendMessage,
} from "wardroom/core";
import { loadConfig, startSession, type PoolState, type Session } from "wardroom/harness";

const REPO = process.cwd();
const ME = process.env.WARDROOM_AGENT ?? "pi";

const WRITE_TOOLS = new Set(["write", "edit", "multi_edit", "str_replace", "apply_patch"]);
const pathOf = (input: any): string | undefined => input?.path ?? input?.file_path ?? input?.filePath;
const text = (t: string) => ({ content: [{ type: "text", text: t }] });

export default function wardroom(pi: any) {
  // ── the embedded crew engine ───────────────────────────────────────────────
  let session: Session | undefined;
  let poolState: PoolState | undefined;
  const log: string[] = [];
  const note = (line: string) => {
    log.push(line);
    if (log.length > 300) log.shift();
  };

  const show = (ctx: any, body: string) => {
    if (typeof ctx?.print === "function") ctx.print(body);
    else if (typeof ctx?.ui?.notify === "function") ctx.ui.notify(body);
    else console.log(body);
  };

  const crewStatus = (): string => {
    if (!session || !poolState) return "No crew running. `/crew start` spawns it from wardroom.json.";
    const panes = poolState.panes
      .map(
        (p) =>
          `${p.agent}: ${p.phase}${p.taskId ? ` ${p.taskId} · ${p.taskTitle}` : ""}` +
          `${p.completed || p.failed ? `  (${p.completed} done${p.failed ? `, ${p.failed} failed` : ""})` : ""}`
      )
      .join("\n");
    return `crew: ${session.crew().join(", ")}\n${panes}`;
  };

  async function crewCommand(args: string, ctx: any): Promise<void> {
    const [sub, ...rest] = args.trim().split(/\s+/);

    if (!sub || sub === "status") return show(ctx, crewStatus());

    if (sub === "start") {
      if (session) return show(ctx, "Crew already running — `/crew status`.");
      const config = loadConfig(REPO);
      const names = rest[0] ? rest[0].split(",").map((s) => s.trim()) : Object.keys(config.agents);
      session = startSession(REPO, names, config, {
        onChange: (state) => {
          poolState = state;
        },
        onPhase: (agent, phase, task) => {
          if (phase === "claimed" && task) note(`${agent} started ${task.id} · ${task.title}`);
          if (phase === "done" && task) note(`${agent} finished ${task.id} · ${task.title}`);
          if (phase === "failed" && task) note(`${agent} FAILED ${task.id} · ${task.title}`);
        },
      });
      return show(ctx, `Crew up: ${names.join(", ")} — fire commands with /crew <order>, watch with /crew log.`);
    }

    if (!session) return show(ctx, "No crew running. `/crew start` first.");

    if (sub === "stop") {
      const s = session;
      session = undefined;
      const result = await s.stop();
      return show(
        ctx,
        `Crew stood down: ${result.completed} done, ${result.failed} failed` +
          (result.writedownFile ? ` — writedown ${result.writedownFile}` : "")
      );
    }

    if (sub === "log") {
      const talk = crosstalk(REPO, 8).map((m) => `${m.from} -> ${m.to} [${m.kind}] ${m.body}`);
      const body = [...log.splice(0), ...(talk.length ? ["-- crosstalk --", ...talk] : [])].join("\n");
      return show(ctx, body || "(quiet so far)");
    }

    if (sub === "hire") {
      const r = session.addAgent(rest[0] ?? "", rest[1]);
      return show(ctx, r.ok ? r.detail : r.error);
    }

    if (sub === "drop") {
      const r = session.removeAgent(rest[0] ?? "");
      return show(ctx, r.ok ? r.detail : r.error);
    }

    // Anything else is an order for the conductor: it becomes live board tasks.
    const order = args.trim();
    const { created, note: conductorNote } = await session.command(order);
    if (created.length === 0) return show(ctx, `conductor: ${conductorNote ?? "nothing to do"}`);
    return show(
      ctx,
      `dispatched ${created.length} task(s):\n` +
        created.map((t) => `  ${t.id}  ${t.title}${t.assignee ? `  @${t.assignee}` : ""}`).join("\n")
    );
  }

  pi.registerCommand("crew", {
    description: "wardroom crew: start | stop | status | log | hire/drop <agent> | <conductor order>",
    handler: crewCommand,
  });

  pi.registerCommand("board", {
    description: "The shared wardroom task board",
    handler: async (_args: string, ctx: any) => show(ctx, renderBoard(REPO)),
  });

  pi.registerCommand("crosstalk", {
    description: "Recent crew messages",
    handler: async (_args: string, ctx: any) =>
      show(ctx, crosstalk(REPO, 15).map((m) => `${m.from} -> ${m.to} [${m.kind}] ${m.body}`).join("\n") || "(none yet)"),
  });

  pi.registerCommand("stats", {
    description: "Parallelism report: speedup, utilization, ready-wait, critical path",
    handler: async (_args: string, ctx: any) => show(ctx, renderStats(REPO)),
  });

  // A crew left running when pi exits would orphan its claims; stand it down.
  pi.on("session_shutdown", async () => {
    if (session) {
      const s = session;
      session = undefined;
      await s.stop();
    }
  });

  // ── the pi session as a crew seat (tools) ──────────────────────────────────

  pi.registerTool({
    name: "wardroom_context",
    label: "Wardroom context",
    description:
      "Situational snapshot of the shared checkout: latest session writedown, open tasks, active file leases, recent events. Call before planning or touching files.",
    parameters: Type.Object({}),
    async execute() {
      return text(getContext(REPO, 15));
    },
  });

  pi.registerTool({
    name: "wardroom_claim_next",
    label: "Claim next task",
    description:
      "Atomically claim the next runnable task from the crew board (dependencies done, files not leased by a peer). Leases its files to you. Never pick board work by hand.",
    parameters: Type.Object({}),
    async execute() {
      const claim = claimNextTask(REPO, ME);
      if (claim.status === "claimed")
        return text(
          `Claimed ${claim.task.id}: ${claim.task.title}\nFiles: ${claim.task.files.join(", ") || "none"}\n${claim.task.description}`
        );
      if (claim.status === "empty") return text(`Nothing claimable: ${claim.reason}`);
      return text(`All eligible tasks blocked by peers' leases: ${JSON.stringify(claim.blocked)}`);
    },
  });

  pi.registerTool({
    name: "wardroom_complete",
    label: "Complete task",
    description: "Mark your claimed task done with a result other agents can build on, releasing its file leases.",
    parameters: Type.Object({ task_id: Type.String(), result: Type.String() }),
    async execute(_id: string, params: any) {
      return text(`${completeTask(REPO, ME, params.task_id, params.result).id} done`);
    },
  });

  pi.registerTool({
    name: "wardroom_fail",
    label: "Fail task",
    description: "Return your claimed task as failed with the reason; releases its leases.",
    parameters: Type.Object({ task_id: Type.String(), reason: Type.String() }),
    async execute(_id: string, params: any) {
      return text(`${failTask(REPO, ME, params.task_id, params.reason).id} failed`);
    },
  });

  pi.registerTool({
    name: "wardroom_plan",
    label: "Plan tasks",
    description:
      "Add tasks to the shared board. Declare each task's file footprint (paths/globs) honestly — disjoint footprints run in parallel, overlapping ones serialize. Optional assignee directs a task to a specific agent (delegation to the headless crew).",
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          title: Type.String(),
          description: Type.Optional(Type.String()),
          files: Type.Optional(Type.Array(Type.String())),
          depends_on: Type.Optional(Type.Array(Type.String())),
          assignee: Type.Optional(Type.String()),
        })
      ),
    }),
    async execute(_id: string, params: any) {
      const { created } = planTasks(REPO, ME, params.tasks);
      return text(created.map((t) => `${t.id} ${t.title}${t.assignee ? ` @${t.assignee}` : ""}`).join("\n"));
    },
  });

  pi.registerTool({
    name: "wardroom_send",
    label: "Message the crew",
    description:
      "Directed, threaded mail to a crew agent, 'captain' (the human) for decisions, or 'all'. Use kind=question when you need an answer; reply in the same thread_id.",
    parameters: Type.Object({
      to: Type.String(),
      body: Type.String(),
      kind: Type.Optional(Type.String()),
      thread_id: Type.Optional(Type.Number()),
    }),
    async execute(_id: string, params: any) {
      const m = sendMessage(REPO, ME, params.to, params.body, (params.kind as any) ?? "info", params.thread_id);
      return text(`sent #${m.seq} -> ${m.to} (thread t${m.thread})`);
    },
  });

  pi.registerTool({
    name: "wardroom_inbox",
    label: "Read crew mail",
    description: "Unread messages addressed to you (marks them read). Answer questions before starting new work.",
    parameters: Type.Object({}),
    async execute() {
      const inbox = getMessages(REPO, ME);
      if (inbox.messages.length === 0) return text("(inbox empty)");
      return text(inbox.messages.map((m) => `#${m.seq} t${m.thread} from ${m.from} [${m.kind}]: ${m.body}`).join("\n"));
    },
  });

  pi.registerTool({
    name: "wardroom_remember",
    label: "Propose crew memory",
    description:
      "Propose a durable decision/convention/gotcha every agent in this repo must respect. Injected into all future prompts (verified, footprint-scoped). Not for session notes or task results.",
    parameters: Type.Object({
      text: Type.String(),
      kind: Type.String(),
      files: Type.Optional(Type.Array(Type.String())),
      verify: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: any) {
      const item = remember(REPO, {
        text: params.text,
        kind: params.kind as any,
        source: ME,
        files: params.files,
        verify: params.verify,
      });
      return text(`remembered ${item.id} [${item.kind}] ${item.text}`);
    },
  });

  // ── guard: leases are ENFORCED inside pi ───────────────────────────────────
  pi.on("tool_call", async (event: any) => {
    if (!WRITE_TOOLS.has(event.toolName ?? event.name)) return;
    const file = pathOf(event.input);
    if (!file) return;
    const { conflicts } = checkFiles(REPO, [file]);
    const foreign = conflicts.filter((c) => c.holder !== ME);
    if (foreign.length > 0) {
      const c = foreign[0];
      return {
        block: true,
        reason:
          `${file} is leased by ${c.holder} (${c.reason}, expires ${c.expires}). ` +
          `Do not edit it — take other work, or message ${c.holder} via wardroom_send.`,
      };
    }
  });

  // ── context: the crew brief rides into every pi turn ───────────────────────
  pi.on("before_agent_start", async (event: any) => {
    const brief = memoryBrief(REPO);
    const extra = [
      "## Wardroom (shared checkout — you are one agent of a crew)",
      `You are "${ME}". Coordinate via the wardroom_* tools; claim before working, never edit files a peer has leased.`,
      brief ? `### Project brief — follow these\n${brief}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    if (typeof event?.appendSystemPrompt === "function") event.appendSystemPrompt(extra);
    else if (event && "systemPrompt" in event) event.systemPrompt = `${event.systemPrompt}\n\n${extra}`;
  });
}
