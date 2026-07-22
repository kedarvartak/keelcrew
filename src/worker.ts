import { execFile } from "child_process";
import { parseClaudeLine } from "./adapters/claude.ts";
import { parseCodexLine } from "./adapters/codex.ts";
import { parseGeminiLine } from "./adapters/gemini.ts";
import { spawnCli } from "./adapters/runner.ts";
import type { AgentEvent, LineParser } from "./adapters/types.ts";
import type { WardroomConfig } from "./config.ts";
import { getContext } from "./context.ts";
import { getMessages } from "./messages.ts";
import { claimNextTask, completeTask, failTask, listTasks, type Task } from "./tasks.ts";

// ── the worker loop ───────────────────────────────────────────────────────────
// One worker drives one agent CLI against the shared board:
//
//   claim_next_task -> assemble prompt (task + context + inbox) -> spawn the
//   CLI headlessly -> stream events -> verification gate -> complete/fail.
//
// The worker owns the task lifecycle; the agent CLI only does the work and
// narrates. That split is deliberate: completion is gated on the verification
// command actually passing, not on the model claiming success.

const PARSERS: Record<string, LineParser> = {
  claude: parseClaudeLine,
  codex: parseCodexLine,
  gemini: parseGeminiLine,
};

export type WorkerHooks = {
  onEvent?: (agent: string, task: Task, event: AgentEvent) => void;
  onStatus?: (line: string) => void;
};

export type TaskOutcome = {
  task: Task;
  status: "done" | "failed";
  summary: string;
};

export type WorkerResult = {
  agent: string;
  completed: number;
  failed: number;
  outcomes: TaskOutcome[];
  stopped: string;
};

function buildPrompt(repoPath: string, agent: string, task: Task): string {
  const inbox = getMessages(repoPath, agent, true, 10);
  const inboxBlock =
    inbox.messages.length > 0
      ? inbox.messages.map((m) => `- from ${m.from} [${m.kind}, thread t${m.thread}]: ${m.body}`).join("\n")
      : "(empty)";

  return [
    `You are "${agent}", one worker in a crew of coding agents sharing this checkout.`,
    `Complete the following task, then STOP. Do not start unrelated work.`,
    ``,
    `## Task ${task.id}: ${task.title}`,
    task.description || "(no further description)",
    ``,
    task.files.length > 0
      ? `Files you may modify (already leased to you): ${task.files.join(", ")}. Do not modify files outside this footprint.`
      : `This task modifies no files (research/review). Do not modify any files.`,
    ``,
    `## Unread messages addressed to you`,
    inboxBlock,
    ``,
    `## Shared context`,
    getContext(repoPath, 10),
    ``,
    `## Finish`,
    `End with a short summary: what you changed, where, and how you verified it.`,
  ].join("\n");
}

function runVerify(command: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ ok: !error, output: `${stdout}\n${stderr}`.trim().slice(-1500) });
      }
    );
  });
}

export async function runWorker(
  repoPath: string,
  agentName: string,
  config: WardroomConfig,
  hooks: WorkerHooks = {},
  maxTasks = Infinity
): Promise<WorkerResult> {
  const agentConfig = config.agents[agentName];
  if (!agentConfig) {
    throw new Error(`No agent "${agentName}" in wardroom.json (known: ${Object.keys(config.agents).join(", ")})`);
  }
  const parser = PARSERS[agentConfig.adapter];
  const timeoutMs = config.taskTimeoutMinutes * 60_000;
  const status = hooks.onStatus ?? (() => {});

  const result: WorkerResult = { agent: agentName, completed: 0, failed: 0, outcomes: [], stopped: "board drained" };

  while (result.completed + result.failed < maxTasks) {
    const claim = claimNextTask(repoPath, agentName);

    if (claim.status === "empty") {
      const pending = listTasks(repoPath, "pending").length;
      const claimed = listTasks(repoPath, "claimed").length;
      if (pending === 0 && claimed === 0) {
        result.stopped = "board drained";
      } else if (claimed > 0) {
        // Another worker (or an interactive session) holds work our pending
        // tasks depend on; a single worker just waits its turn.
        status(`${agentName}: waiting - ${claim.reason}`);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      } else {
        result.stopped = `stuck: ${pending} pending task(s) with unsatisfiable dependencies (failed prerequisites?)`;
      }
      break;
    }

    if (claim.status === "all-blocked") {
      const holders = [...new Set(claim.blocked.flatMap((b) => b.conflicts.map((c) => c.holder)))];
      status(`${agentName}: all eligible tasks blocked by lease(s) held by ${holders.join(", ")}; waiting`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    const task = claim.task;
    status(`${agentName}: claimed ${task.id} - ${task.title}`);

    const prompt = buildPrompt(repoPath, agentName, task);
    const spawned = spawnCli(agentConfig.bin, agentConfig.args, prompt, repoPath, timeoutMs, parser);

    let agentOk = false;
    let agentSummary = "";
    const textTail: string[] = [];
    for await (const event of spawned.events) {
      hooks.onEvent?.(agentName, task, event);
      if (event.kind === "text") {
        textTail.push(event.text);
        if (textTail.length > 5) textTail.shift();
      } else if (event.kind === "result") {
        agentOk = event.ok;
        agentSummary = event.summary;
      }
    }
    // Adapters without a native result event synthesize a generic summary from
    // the exit code; the agent's own last words are more useful when we have them.
    if (!agentSummary || (agentOk && agentSummary === "exited cleanly")) {
      agentSummary = textTail.join(" ").slice(-500) || agentSummary || "(no output)";
    }

    let outcome: "done" | "failed";
    let detail: string;

    if (!agentOk) {
      outcome = "failed";
      detail = agentSummary;
    } else if (config.verify && task.files.length > 0) {
      status(`${agentName}: verifying ${task.id} (${config.verify})`);
      const verify = await runVerify(config.verify, repoPath, timeoutMs);
      if (verify.ok) {
        outcome = "done";
        detail = agentSummary;
      } else {
        outcome = "failed";
        detail = `verification failed (${config.verify}): ${verify.output.slice(-600)}`;
      }
    } else {
      outcome = "done";
      detail = agentSummary;
    }

    if (outcome === "done") {
      completeTask(repoPath, agentName, task.id, detail.slice(0, 800));
      result.completed += 1;
    } else {
      failTask(repoPath, agentName, task.id, detail.slice(0, 800));
      result.failed += 1;
    }
    result.outcomes.push({ task, status: outcome, summary: detail });
    status(`${agentName}: ${task.id} ${outcome}`);
  }

  if (result.completed + result.failed >= maxTasks) {
    result.stopped = `reached max tasks (${maxTasks})`;
  }
  return result;
}
