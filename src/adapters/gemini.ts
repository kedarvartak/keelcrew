import type { LineParser } from "./types.ts";

// ── Gemini CLI adapter ────────────────────────────────────────────────────────
// `gemini -p` streams plain text to stdout with no stable structured format,
// so every line is a text event and the terminal result is synthesized by the
// runner from the exit code. If/when gemini ships a stable JSON stream this
// parser upgrades without touching anything above the adapter layer.

export const parseGeminiLine: LineParser = (line) => {
  const text = line.trim();
  if (!text) return [];
  return [{ kind: "text", text }];
};
