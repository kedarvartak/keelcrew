import type { AgentEvent, LineParser } from "./types.ts";

// ── Claude Code adapter ───────────────────────────────────────────────────────
// `claude -p --output-format stream-json --verbose` emits one JSON object per
// line:
//   {"type":"assistant","message":{"content":[{"type":"text","text":...},
//                                             {"type":"tool_use","name":...,"input":{...}}]}}
//   {"type":"result","subtype":"success"|"error_*","result":"...",
//    "total_cost_usd":..., "usage":{"output_tokens":...}}
// Anything unrecognized degrades to plain text.

function toolDetail(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const hint = record.file_path ?? record.command ?? record.pattern ?? record.path ?? "";
    if (hint) return `${name} ${String(hint)}`.slice(0, 200);
  }
  return name;
}

export const parseClaudeLine: LineParser = (line) => {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(line);
  } catch {
    return [{ kind: "text", text: line }];
  }

  const events: AgentEvent[] = [];

  if (json.type === "assistant") {
    const message = json.message as { content?: unknown[] } | undefined;
    for (const block of message?.content ?? []) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        events.push({ kind: "text", text: b.text.trim() });
      } else if (b.type === "tool_use" && typeof b.name === "string") {
        events.push({ kind: "tool", name: b.name, detail: toolDetail(b.name, b.input) });
      }
    }
  } else if (json.type === "result") {
    const ok = json.subtype === "success" && json.is_error !== true;
    const summary = typeof json.result === "string" && json.result.trim()
      ? json.result.trim()
      : `finished (${String(json.subtype ?? "unknown")})`;
    events.push({ kind: "result", ok, summary });

    const usage = json.usage as { output_tokens?: number } | undefined;
    if (typeof json.total_cost_usd === "number" || usage?.output_tokens !== undefined) {
      events.push({ kind: "usage", tokens: usage?.output_tokens, costUsd: json.total_cost_usd as number | undefined });
    }
  }

  return events;
};
