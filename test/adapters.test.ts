import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClaudeLine } from "../src/adapters/claude.ts";
import { parseCodexLine } from "../src/adapters/codex.ts";
import { parseGeminiLine } from "../src/adapters/gemini.ts";

// Fixture lines recorded from real CLI output shapes. Parsers must be
// tolerant: garbage degrades to text/noise, never a throw (CLI formats drift).

test("claude: assistant text and tool_use blocks", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Adding the route now." },
        { type: "tool_use", name: "Edit", input: { file_path: "src/api/routes.ts" } },
      ],
    },
  });
  const events = parseClaudeLine(line);
  assert.deepEqual(events[0], { kind: "text", text: "Adding the route now." });
  assert.deepEqual(events[1], { kind: "tool", name: "Edit", detail: "Edit src/api/routes.ts" });
});

test("claude: result success with usage", () => {
  const line = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Added POST /auth/refresh; tests pass.",
    total_cost_usd: 0.0421,
    usage: { output_tokens: 912 },
  });
  const events = parseClaudeLine(line);
  assert.deepEqual(events[0], { kind: "result", ok: true, summary: "Added POST /auth/refresh; tests pass." });
  assert.deepEqual(events[1], { kind: "usage", tokens: 912, costUsd: 0.0421 });
});

test("claude: error result and non-JSON degrade safely", () => {
  const events = parseClaudeLine(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }));
  assert.equal(events[0].kind, "result");
  assert.equal((events[0] as { ok: boolean }).ok, false);

  assert.deepEqual(parseClaudeLine("plain text noise"), [{ kind: "text", text: "plain text noise" }]);
});

test("codex: agent message, command execution, file change, turn lifecycle", () => {
  const msg = parseCodexLine(
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "UI wired to the API." } })
  );
  assert.deepEqual(msg, [{ kind: "text", text: "UI wired to the API." }]);

  const cmd = parseCodexLine(
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm test" } })
  );
  assert.deepEqual(cmd, [{ kind: "tool", name: "shell", detail: "npm test" }]);

  const edit = parseCodexLine(
    JSON.stringify({
      type: "item.completed",
      item: { type: "file_change", changes: [{ path: "src/ui/App.tsx" }, { path: "src/ui/api.ts" }] },
    })
  );
  assert.deepEqual(edit, [{ kind: "tool", name: "edit", detail: "src/ui/App.tsx, src/ui/api.ts" }]);

  const done = parseCodexLine(JSON.stringify({ type: "turn.completed", usage: { output_tokens: 512 } }));
  assert.deepEqual(done[0], { kind: "usage", tokens: 512 });
  assert.deepEqual(done[1], { kind: "result", ok: true, summary: "turn completed" });

  const failed = parseCodexLine(JSON.stringify({ type: "turn.failed", error: { message: "sandbox denied" } }));
  assert.deepEqual(failed, [{ kind: "result", ok: false, summary: "sandbox denied" }]);
});

test("gemini: plain lines become text events, blanks are dropped", () => {
  assert.deepEqual(parseGeminiLine("Refactoring the config loader."), [
    { kind: "text", text: "Refactoring the config loader." },
  ]);
  assert.deepEqual(parseGeminiLine("   "), []);
});
