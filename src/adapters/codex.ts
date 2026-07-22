import type { AgentEvent, LineParser } from "./types.ts";

// ── Codex CLI adapter ─────────────────────────────────────────────────────────
// `codex exec --json` emits JSONL experimental events. The shapes that matter:
//   {"type":"item.completed","item":{"item_type"|"type":"agent_message","text":...}}
//   {"type":"item.completed","item":{"type":"command_execution","command":...}}
//   {"type":"item.completed","item":{"type":"file_change","changes":[...]}}
//   {"type":"turn.completed","usage":{"output_tokens":...}}
//   {"type":"turn.failed","error":{"message":...}}
// The format is explicitly experimental, so parsing is tolerant: unknown
// shapes degrade to noise, never to a crash (see docs/plan.md risks).

export const parseCodexLine: LineParser = (line) => {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(line);
  } catch {
    return [{ kind: "text", text: line }];
  }

  const type = String(json.type ?? "");
  const events: AgentEvent[] = [];

  if (type === "item.completed" || type === "item.updated") {
    const item = (json.item ?? {}) as Record<string, unknown>;
    const itemType = String(item.item_type ?? item.type ?? "");
    if (itemType === "agent_message" && typeof item.text === "string" && item.text.trim()) {
      if (type === "item.completed") {
        events.push({ kind: "text", text: item.text.trim() });
      }
    } else if (itemType === "command_execution") {
      events.push({ kind: "tool", name: "shell", detail: String(item.command ?? "").slice(0, 200) });
    } else if (itemType === "file_change") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes
        .map((c) => String((c as Record<string, unknown>).path ?? ""))
        .filter(Boolean)
        .join(", ");
      events.push({ kind: "tool", name: "edit", detail: paths || "file change" });
    } else if (itemType === "reasoning") {
      // thinking summaries are noise for the dashboard; drop them
    }
  } else if (type === "turn.completed") {
    const usage = json.usage as { output_tokens?: number } | undefined;
    if (usage?.output_tokens !== undefined) {
      events.push({ kind: "usage", tokens: usage.output_tokens });
    }
    events.push({ kind: "result", ok: true, summary: "turn completed" });
  } else if (type === "turn.failed" || type === "error") {
    const error = json.error as { message?: string } | undefined;
    events.push({
      kind: "result",
      ok: false,
      summary: error?.message ?? (typeof json.message === "string" ? json.message : "turn failed"),
    });
  }

  return events;
};
