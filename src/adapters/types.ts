// ── adapter contract ──────────────────────────────────────────────────────────
// An adapter turns one agent CLI's headless mode into a normalized event
// stream. Adapters are the ONLY code that knows CLI-specific flags and output
// shapes; everything above them is agent-agnostic. Adding a fourth CLI is one
// new file implementing `parseLine` plus a default invocation.

export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; detail: string }
  | { kind: "result"; ok: boolean; summary: string }
  | { kind: "usage"; tokens?: number; costUsd?: number };

// A parser consumes one stdout line and yields zero or more events. It must
// never throw on unrecognized input — CLIs drift, and garbage in the stream
// should degrade to noise, not crash a worker.
export type LineParser = (line: string) => AgentEvent[];

export type SpawnedAgent = {
  events: AsyncIterable<AgentEvent>;
  kill: () => void;
};
