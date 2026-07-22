import { spawn } from "child_process";
import readline from "readline";
import type { AgentEvent, LineParser, SpawnedAgent } from "./types.ts";

// ── shared CLI runner ─────────────────────────────────────────────────────────
// Spawns a headless agent CLI, feeds the prompt on argv, streams stdout line
// by line through the adapter's parser, and enforces the two contract
// guarantees every adapter must give the worker:
//
//   1. a hard wall-clock timeout — a hung CLI is killed, and the stream ends
//      with a failed `result` event rather than hanging the worker;
//   2. exactly one terminal `result` event, synthesized from the exit code if
//      the CLI never emitted its own.

export function spawnCli(
  bin: string,
  args: string[],
  prompt: string,
  cwd: string,
  timeoutMs: number,
  parseLine: LineParser
): SpawnedAgent {
  const child = spawn(bin, [...args, prompt], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });

  let killedByTimeout = false;
  let killedByUser = false;
  const timer = setTimeout(() => {
    killedByTimeout = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  const kill = () => {
    killedByUser = true;
    clearTimeout(timer);
    child.kill("SIGKILL");
  };

  async function* events(): AsyncGenerator<AgentEvent> {
    let sawResult = false;
    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    const spawnError = new Promise<Error | null>((resolve) => {
      child.on("error", (error) => resolve(error));
      child.on("spawn", () => resolve(null));
    });

    const rl = readline.createInterface({ input: child.stdout });
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let parsed: AgentEvent[];
        try {
          parsed = parseLine(line);
        } catch {
          parsed = [{ kind: "text", text: line }];
        }
        for (const event of parsed) {
          if (event.kind === "result") sawResult = true;
          yield event;
        }
      }
    } finally {
      rl.close();
    }

    const startupFailure = await spawnError;
    const exitCode: number | null = await new Promise((resolve) => {
      if (child.exitCode !== null || startupFailure) resolve(child.exitCode);
      else child.on("close", (code) => resolve(code));
    });
    clearTimeout(timer);

    if (startupFailure) {
      yield { kind: "result", ok: false, summary: `failed to start ${bin}: ${startupFailure.message}` };
    } else if (killedByTimeout) {
      yield { kind: "result", ok: false, summary: `timed out after ${Math.round(timeoutMs / 1000)}s and was killed` };
    } else if (killedByUser) {
      yield { kind: "result", ok: false, summary: "stopped by the captain" };
    } else if (!sawResult) {
      const ok = exitCode === 0;
      yield {
        kind: "result",
        ok,
        summary: ok ? "exited cleanly" : `exited with code ${exitCode}${stderrTail ? `: ${stderrTail.slice(-300)}` : ""}`,
      };
    }
  }

  return { events: events(), kill };
}
