import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import test from "node:test";

import {
  appendMessage,
  getContext,
  getDecisions,
  readMemory,
  searchMemory,
  startSession,
  summarizeSession,
} from "../src/memory.ts";

function makeRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-memo-"));
}

test("startSession creates AGENTS.md with a dated section", () => {
  const repoPath = makeRepo();
  const result = startSession(repoPath, "codex", "coder");
  const content = fs.readFileSync(path.join(repoPath, "AGENTS.md"), "utf8");

  assert.equal(result.status, "created");
  assert.match(content, /^---\nformat: 1\nproject: multi-agent-memo-/m);
  assert.match(content, /## Session: \d{4}-\d{2}-\d{2}/);
  assert.match(content, /### codex — coder/);
});

test("appendMessage creates the section if the caller skipped startSession", () => {
  const repoPath = makeRepo();
  appendMessage(repoPath, "claude", "architect", "claude", "Scaffolded auth.");

  const content = fs.readFileSync(path.join(repoPath, "AGENTS.md"), "utf8");
  assert.match(content, /## Session: \d{4}-\d{2}-\d{2}/);
  assert.match(content, /### claude — architect/);
  assert.match(content, /\*\*claude\*\* — Scaffolded auth\./);
});

test("readMemory supports agent and persona filtering", () => {
  const repoPath = makeRepo();
  appendMessage(repoPath, "codex", "coder", "codex", "Built endpoint.");
  appendMessage(repoPath, "gemini", "reviewer", "gemini", "Found a bug.");

  const byAgent = readMemory(repoPath, "codex");
  const byPersona = readMemory(repoPath, undefined, "reviewer");

  assert.match(byAgent, /codex\/coder codex: Built endpoint\./);
  assert.doesNotMatch(byAgent, /gemini/);
  assert.match(byPersona, /gemini\/reviewer gemini: Found a bug\./);
  assert.doesNotMatch(byPersona, /Built endpoint/);
});

test("getContext returns the last N compact entries", () => {
  const repoPath = makeRepo();
  appendMessage(repoPath, "codex", "coder", "me", "First");
  appendMessage(repoPath, "codex", "coder", "codex", "Second");
  appendMessage(repoPath, "codex", "coder", "me", "Third");

  const context = getContext(repoPath, 2);
  assert.doesNotMatch(context, /First/);
  assert.match(context, /Second/);
  assert.match(context, /Third/);
});

test("searchMemory finds keyword and tag matches", () => {
  const repoPath = makeRepo();
  appendMessage(repoPath, "codex", "coder", "codex", "Use Redis for persistence. #decision");
  appendMessage(
    repoPath,
    "gemini",
    "reviewer",
    "gemini",
    "JWT refresh handling is blocked on test coverage. #blocker"
  );

  const results = searchMemory(repoPath, "Redis", 5);
  const tagged = searchMemory(repoPath, "#blocker", 5, undefined, undefined, "blocker");

  assert.equal(results.length, 1);
  assert.match(results[0].message, /Use Redis/);
  assert.equal(results[0].tags[0], "decision");
  assert.equal(tagged.length, 1);
  assert.match(tagged[0].message, /blocked on test coverage/);
});

test("getDecisions returns tagged and heuristic decisions", () => {
  const repoPath = makeRepo();
  appendMessage(repoPath, "codex", "coder", "me", "Use Redis for persistence.");
  appendMessage(repoPath, "claude", "architect", "claude", "Need more logs. #todo");
  appendMessage(
    repoPath,
    "gemini",
    "reviewer",
    "gemini",
    "Chosen fix: invalidate tokens on password change. #decision"
  );

  const decisions = getDecisions(repoPath);

  assert.equal(decisions.length, 2);
  assert.match(decisions[0], /Use Redis for persistence/);
  assert.match(decisions[1], /invalidate tokens on password change/);
});

test("summarizeSession groups decisions blockers and todos", () => {
  const repoPath = makeRepo();
  appendMessage(repoPath, "codex", "coder", "codex", "Use Redis for persistence. #decision");
  appendMessage(repoPath, "gemini", "reviewer", "gemini", "Auth regression is blocking release. #blocker");
  appendMessage(repoPath, "claude", "architect", "me", "Document token expiry behavior. #todo");

  const summary = summarizeSession(repoPath);

  assert.equal(summary.messageCount, 3);
  assert.deepEqual(summary.participants.sort(), [
    "claude/architect",
    "codex/coder",
    "gemini/reviewer",
  ]);
  assert.equal(summary.decisions.length, 1);
  assert.equal(summary.blockers.length, 1);
  assert.equal(summary.todos.length, 1);
});
