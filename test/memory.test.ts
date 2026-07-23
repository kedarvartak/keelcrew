import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { WardroomConfig } from "../src/config.ts";
import { interpretCommand } from "../src/conductor.ts";
import {
  forgetMemory,
  listMemory,
  memoryBrief,
  pinMemory,
  remember,
  verifyMemory,
} from "../src/memory.ts";
import { planTasks } from "../src/tasks.ts";
import { runWorker } from "../src/worker.ts";

function makeRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wardroom-mem-"));
}

function makeGitRepo(): string {
  const repo = makeRepo();
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "seed.txt"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: repo });
  return repo;
}

test("remember stores items; re-proposing bumps confidence instead of duplicating", () => {
  const repo = makeRepo();
  const first = remember(repo, { text: "validate request bodies with zod", kind: "convention", source: "claude" });
  assert.equal(first.confidence, 0.7);

  const again = remember(repo, { text: "Validate request bodies with ZOD", kind: "convention", source: "codex" });
  assert.equal(again.id, first.id);
  assert.ok(Math.abs(again.confidence - 0.8) < 1e-9);
  assert.equal(listMemory(repo).length, 1);
});

test("pin raises confidence and forget removes; unknown ids throw", () => {
  const repo = makeRepo();
  const item = remember(repo, { text: "auth uses JWT, not sessions", kind: "decision", source: "captain" });
  const pinned = pinMemory(repo, item.id);
  assert.equal(pinned.pinned, true);
  assert.ok(pinned.confidence >= 0.9);

  forgetMemory(repo, item.id);
  assert.equal(listMemory(repo).length, 0);
  assert.throws(() => pinMemory(repo, "mem-nope"), /Unknown memory item/);
  assert.throws(() => forgetMemory(repo, "mem-nope"), /Unknown memory item/);
});

test("the brief is scoped by footprint overlap and repo-wide items always apply", () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src/auth.ts"), "");
  remember(repo, { text: "never log raw passwords", kind: "gotcha", source: "claude", files: ["src/auth.ts"] });
  remember(repo, { text: "no default exports", kind: "convention", source: "codex" });

  const authBrief = memoryBrief(repo, ["src/auth.ts"]);
  assert.match(authBrief, /never log raw passwords/);
  assert.match(authBrief, /no default exports/);

  const docsBrief = memoryBrief(repo, ["docs/x.md"]);
  assert.doesNotMatch(docsBrief, /never log raw passwords/);
  assert.match(docsBrief, /no default exports/);

  // No footprint (conductor view): everything applies.
  assert.match(memoryBrief(repo), /never log raw passwords/);
});

test("the brief respects its character budget, highest confidence first", () => {
  const repo = makeRepo();
  remember(repo, { text: "low priority note about formatting details", kind: "convention", source: "a", confidence: 0.3 });
  remember(repo, { text: "critical: API keys live in env, never in code", kind: "gotcha", source: "b", confidence: 0.95 });

  const brief = memoryBrief(repo, undefined, 60);
  assert.match(brief, /API keys/);
  assert.doesNotMatch(brief, /formatting/);
});

test("a failing verify predicate decays the item and repeated failure prunes it", () => {
  const repo = makeRepo();
  remember(repo, { text: "zod is a dependency", kind: "decision", source: "claude", verify: "exit 1" });

  // First failure: decayed (0.7 -> 0.35), excluded from the brief, still stored.
  assert.equal(memoryBrief(repo), "");
  const [decayed] = listMemory(repo);
  assert.ok(Math.abs(decayed.confidence - 0.35) < 1e-9);

  // Second failure: 0.175 < floor -> pruned from the store entirely.
  verifyMemory(repo);
  assert.equal(listMemory(repo).length, 0);
});

test("a passing verify predicate keeps the item and stamps lastVerified", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ dependencies: { zod: "^3.0.0" } }));
  remember(repo, { text: "zod is a dependency", kind: "decision", source: "claude", verify: "grep -q zod package.json" });

  assert.match(memoryBrief(repo), /zod is a dependency/);
  assert.ok(listMemory(repo)[0].lastVerified);
});

test("an item scoped to files that no longer exist goes stale; pinned items survive decay", () => {
  const repo = makeRepo();
  remember(repo, { text: "legacy module quirk", kind: "gotcha", source: "codex", files: ["src/legacy.ts"] });
  const kept = remember(repo, { text: "important but unverifiable", kind: "decision", source: "captain", verify: "exit 1" });
  pinMemory(repo, kept.id);

  assert.doesNotMatch(memoryBrief(repo), /legacy module quirk/);
  verifyMemory(repo);
  verifyMemory(repo);
  const ids = listMemory(repo).map((i) => i.id);
  assert.ok(ids.includes(kept.id), "pinned item was pruned");
  assert.ok(!ids.some((id) => id !== kept.id), "stale scoped item survived");
});

// ── enforcement: the brief lands in real prompts ─────────────────────────────

const DUMP_AGENT = `
import fs from "fs";
fs.writeFileSync("prompt.txt", process.argv.slice(3).join(" "));
console.log("done");
`;

function dumpConfig(repo: string, agent: string): WardroomConfig {
  const file = path.join(repo, "dump.mjs");
  fs.writeFileSync(file, DUMP_AGENT);
  return {
    agents: { [agent]: { adapter: "gemini", bin: process.execPath, args: [file, agent] } },
    taskTimeoutMinutes: 5,
    review: "off",
    planner: agent,
    conductor: agent,
  };
}

test("a worker's prompt contains the footprint-scoped project brief", async () => {
  const repo = makeGitRepo();
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src/auth.ts"), "");
  remember(repo, { text: "never log raw passwords", kind: "gotcha", source: "codex", files: ["src/auth.ts"] });
  remember(repo, { text: "irrelevant docs-only note", kind: "convention", source: "codex", files: ["docs/**"] });

  planTasks(repo, "conductor", [{ title: "harden auth", files: ["src/auth.ts"] }]);
  await runWorker(repo, "claude", dumpConfig(repo, "claude"), {}, 1);

  const prompt = fs.readFileSync(path.join(repo, "prompt.txt"), "utf8");
  assert.match(prompt, /## Project brief — follow these/);
  assert.match(prompt, /never log raw passwords/);
  assert.doesNotMatch(prompt, /docs-only note/);
});

test("the conductor's planning prompt contains the crew brief", async () => {
  const repo = makeGitRepo();
  remember(repo, { text: "split UI and API into separate tasks", kind: "convention", source: "captain" });

  await interpretCommand(repo, dumpConfig(repo, "claude"), ["claude"], "add a settings page");
  const prompt = fs.readFileSync(path.join(repo, "prompt.txt"), "utf8");
  assert.match(prompt, /Project brief \(crew memory/);
  assert.match(prompt, /split UI and API/);
});
