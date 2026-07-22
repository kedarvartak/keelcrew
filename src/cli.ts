#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { sendMessage, MESSAGE_KINDS, type MessageKind } from "./messages.ts";
import { renderBoard } from "./tasks.ts";
import { renderDashboard, renderLog } from "./renderer.ts";

// ── wardroom CLI ──────────────────────────────────────────────────────────────
// Phase 1 surface: mcp | board | log | say | watch. The conductor-driven
// commands (plan, run, crew, stop) arrive in Phases 2-4 per docs/plan.md.

const HELP = `wardroom - one terminal for parallel coding agents on one checkout

usage: wardroom <command> [options]

commands:
  mcp                     start the MCP server over stdio (wire this into
                          Claude Code / Codex / Gemini CLI configs)
  run --agents A[,B,...] [--max-tasks N] [--no-tty]
                          drain the task board with a pool of headless
                          workers (one per agent), live multiplexed view
  watch                   live dashboard: board, claims, crosstalk, events
  board                   print the task board and exit
  log [-n N] [--follow]   merged events + messages timeline
  say <msg> [--to AGENT] [--kind KIND] [--thread N]
                          send a message as the captain (default to: all)
  help                    show this help

The repo is the current working directory. State lives in ./.memo/.
`;

function repoPath(): string {
  const repo = process.cwd();
  if (!fs.existsSync(path.join(repo, ".git")) && !fs.existsSync(path.join(repo, ".memo"))) {
    process.stderr.write(`warning: ${repo} has no .git or .memo - is this the right directory?\n`);
  }
  return repo;
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (value === undefined) {
    throw new Error(`${flag} requires a value`);
  }
  args.splice(idx, 2);
  return value;
}

function hasFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

async function cmdWatch(repo: string): Promise<void> {
  const ALT_SCREEN_ON = "\x1b[?1049h";
  const ALT_SCREEN_OFF = "\x1b[?1049l";
  const CLEAR = "\x1b[2J\x1b[H";
  const memo = path.join(repo, ".memo");
  fs.mkdirSync(memo, { recursive: true });

  let last = "";
  const draw = () => {
    let frame: string;
    try {
      frame = renderDashboard(repo, process.stdout.columns ?? 78);
    } catch (error) {
      frame = `wardroom watch: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (frame !== last) {
      last = frame;
      process.stdout.write(CLEAR + frame + "\n");
    }
  };

  const cleanup = () => {
    process.stdout.write(ALT_SCREEN_OFF);
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  process.stdout.write(ALT_SCREEN_ON);
  draw();

  // fs.watch for sub-second reaction, interval as a safety net (fs.watch is
  // platform-flaky for atomic renames), light debounce to coalesce bursts.
  let pending: NodeJS.Timeout | null = null;
  const schedule = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      draw();
    }, 150);
  };
  try {
    fs.watch(memo, schedule);
  } catch {
    // fall back to interval-only
  }
  setInterval(draw, 1000);
}

async function cmdLog(repo: string, args: string[]): Promise<void> {
  const n = Number(flagValue(args, "-n") ?? 50);
  const follow = hasFlag(args, "--follow") || hasFlag(args, "-f");
  process.stdout.write(renderLog(repo, n) + "\n");
  if (!follow) return;

  let last = renderLog(repo, Number.MAX_SAFE_INTEGER);
  setInterval(() => {
    const current = renderLog(repo, Number.MAX_SAFE_INTEGER);
    if (current !== last) {
      const fresh = current.startsWith(last) ? current.slice(last.length).replace(/^\n/, "") : current;
      if (fresh.trim()) process.stdout.write(fresh + "\n");
      last = current;
    }
  }, 500);
}

function cmdSay(repo: string, args: string[]): void {
  const to = flagValue(args, "--to") ?? "all";
  const kind = (flagValue(args, "--kind") ?? "info") as MessageKind;
  const threadRaw = flagValue(args, "--thread");
  const thread = threadRaw === undefined ? undefined : Number(threadRaw);
  const body = args.join(" ").trim();
  if (!body) {
    throw new Error('usage: wardroom say "<message>" [--to agent] [--kind ' + MESSAGE_KINDS.join("|") + "] [--thread N]");
  }
  const message = sendMessage(repo, "captain", to, body, kind, thread);
  process.stdout.write(`sent #${message.seq} captain -> ${message.to} (thread t${message.thread})\n`);
}

async function cmdRun(repo: string, args: string[]): Promise<void> {
  const { loadConfig } = await import("./config.ts");
  const { runPool } = await import("./pool.ts");
  const { renderPool } = await import("./renderer.ts");

  const noTty = hasFlag(args, "--no-tty") || hasFlag(args, "--plain");
  const agentsRaw = flagValue(args, "--agents");
  if (!agentsRaw) {
    throw new Error("usage: wardroom run --agents <name>[,<name>...] [--max-tasks N] [--no-tty]");
  }
  const agents = agentsRaw.split(",").map((a) => a.trim()).filter(Boolean);
  const maxTasks = Number(flagValue(args, "--max-tasks") ?? Infinity);
  const config = loadConfig(repo);

  const DIM = "\x1b[2m";
  const CYAN = "\x1b[36m";
  const YELLOW = "\x1b[33m";
  const RESET = "\x1b[0m";

  const live = process.stdout.isTTY && !noTty;

  if (live) {
    const ALT_ON = "\x1b[?1049h";
    const ALT_OFF = "\x1b[?1049l";
    const CLEAR = "\x1b[2J\x1b[H";
    let latest = "";
    let dirty = true;
    const draw = () => {
      if (!dirty) return;
      dirty = false;
      process.stdout.write(CLEAR + latest + "\n");
    };
    const timer = setInterval(draw, 200);
    process.stdout.write(ALT_ON);
    const restore = () => {
      clearInterval(timer);
      process.stdout.write(ALT_OFF);
    };
    process.on("SIGINT", () => {
      restore();
      process.exit(130);
    });

    try {
      const result = await runPool(
        repo,
        agents,
        config,
        {
          onChange: (state) => {
            latest = renderPool(repo, state, process.stdout.columns ?? 88);
            dirty = true;
          },
        },
        { maxTasksPerAgent: maxTasks, sweepMs: 10_000 }
      );
      restore();
      process.stdout.write(
        `${result.completed} done, ${result.failed} failed across ${agents.join(", ")} in ${Math.round(result.durationMs / 1000)}s` +
          (result.requeued.length ? ` (requeued ${result.requeued.length} orphaned)` : "") +
          (result.writedownFile ? `\nwritedown: ${result.writedownFile}` : "") +
          "\n"
      );
      if (result.failed > 0) process.exitCode = 1;
    } catch (error) {
      restore();
      throw error;
    }
    return;
  }

  // Non-TTY / --no-tty: interleaved labeled lines, loggable and CI-friendly.
  const result = await runPool(
    repo,
    agents,
    config,
    {
      onStatus: (line) => process.stdout.write(`${YELLOW}== ${line}${RESET}\n`),
      onLine: (agent, taskId, event) => {
        const tag = `${CYAN}[${agent} ${taskId}]${RESET}`;
        if (event.kind === "text") process.stdout.write(`${tag} ${event.text}\n`);
        else if (event.kind === "tool") process.stdout.write(`${tag} ${DIM}${event.detail}${RESET}\n`);
        else if (event.kind === "result")
          process.stdout.write(`${tag} ${event.ok ? "" : YELLOW}result: ${event.summary}${RESET}\n`);
      },
    },
    { maxTasksPerAgent: maxTasks, sweepMs: 10_000 }
  );
  process.stdout.write(
    `\n${result.completed} done, ${result.failed} failed across ${agents.join(", ")} in ${Math.round(result.durationMs / 1000)}s` +
      (result.requeued.length ? ` (requeued ${result.requeued.length} orphaned)` : "") +
      "\n"
  );
  if (result.failed > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "run":
      await cmdRun(repoPath(), args);
      return;
    case "mcp": {
      const { runMcp } = await import("./mcp.ts");
      await runMcp();
      return; // keeps running on stdio
    }
    case "watch":
      await cmdWatch(repoPath());
      return;
    case "board":
      process.stdout.write(renderBoard(repoPath()) + "\n");
      return;
    case "log":
      await cmdLog(repoPath(), args);
      return;
    case "say":
      cmdSay(repoPath(), args);
      return;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(HELP);
      if (command === undefined) process.exitCode = 1;
      return;
    default:
      process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`wardroom: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
