import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { pathsOverlap } from "./claims.ts";
import {
  memoDir,
  normalizeLabel,
  nowIso,
  readJson,
  shortId,
  withLock,
  writeJsonAtomic,
} from "./store.ts";

// ── crew memory: an enforced, verified, self-pruning brief ────────────────────
// Distinct from writedown.ts (session snapshots): this is the store of small,
// durable facts the whole crew must respect — decisions, conventions, gotchas.
// Three properties separate it from a memory *file*:
//
//   obeyed    — it is injected into every worker/conductor prompt as a
//               "Project brief" (memoryBrief), scoped to the task's footprint,
//               under a hard size budget. Not a file the agent may skip.
//   verified  — an item can carry a shell `verify` predicate (exit 0 = still
//               true) and/or `files` it applies to. Before injection, failing
//               items are down-weighted; repeated failure prunes them. Stale
//               memory dies instead of rotting.
//   proposed  — agents PROPOSE memory via the `remember` MCP tool; nothing is
//               auto-captured. The captain curates with `wardroom memory`
//               (list / pin / forget). Pinned items never decay.

const MEMORY_FILE = "memory.json";
const VERIFY_TIMEOUT_MS = 4_000;
const DECAY_ON_FAIL = 0.5;
const PRUNE_BELOW = 0.2;
const DEFAULT_CONFIDENCE = 0.7;
const MAX_TEXT = 300;

export const MEMORY_KINDS = ["decision", "convention", "gotcha"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export type MemoryItem = {
  id: string;
  text: string;
  kind: MemoryKind;
  // Paths/globs this applies to; absent or empty = repo-wide.
  files?: string[];
  confidence: number;
  pinned?: boolean;
  // Who proposed it: an agent name, "captain", or a task id.
  source: string;
  created: string;
  lastVerified?: string;
  // Shell predicate run from the repo root; exit 0 means the item still holds.
  verify?: string;
};

type MemoryState = { items: MemoryItem[] };

function memoryPath(repoPath: string): string {
  return path.join(memoDir(repoPath), MEMORY_FILE);
}

function loadState(repoPath: string): MemoryState {
  return readJson<MemoryState>(memoryPath(repoPath), { items: [] });
}

export type RememberInput = {
  text: string;
  kind: MemoryKind;
  source: string;
  files?: string[];
  verify?: string;
  confidence?: number;
};

export function remember(repoPath: string, input: RememberInput): MemoryItem {
  const text = normalizeLabel(input.text, "text").slice(0, MAX_TEXT);
  if (!MEMORY_KINDS.includes(input.kind)) {
    throw new Error(`kind must be one of: ${MEMORY_KINDS.join(", ")}`);
  }
  const source = normalizeLabel(input.source, "source");
  const confidence = Math.min(1, Math.max(0.05, input.confidence ?? DEFAULT_CONFIDENCE));

  return withLock(repoPath, "memory", () => {
    const state = loadState(repoPath);

    // Re-proposing an existing fact is confirmation, not duplication: bump its
    // confidence instead of stacking a twin the brief would waste budget on.
    const existing = state.items.find(
      (item) => item.text.toLowerCase() === text.toLowerCase() && item.kind === input.kind
    );
    if (existing) {
      existing.confidence = Math.min(1, existing.confidence + 0.1);
      existing.lastVerified = nowIso();
      writeJsonAtomic(memoryPath(repoPath), state);
      return existing;
    }

    const item: MemoryItem = {
      id: `mem-${shortId()}`,
      text,
      kind: input.kind,
      ...(input.files && input.files.length > 0 ? { files: input.files } : {}),
      confidence,
      source,
      created: nowIso(),
      ...(input.verify ? { verify: input.verify } : {}),
    };
    state.items.push(item);
    writeJsonAtomic(memoryPath(repoPath), state);
    return item;
  });
}

export function listMemory(repoPath: string): MemoryItem[] {
  const items = [...loadState(repoPath).items];
  items.sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.confidence - a.confidence);
  return items;
}

export function pinMemory(repoPath: string, id: string): MemoryItem {
  return withLock(repoPath, "memory", () => {
    const state = loadState(repoPath);
    const item = state.items.find((i) => i.id === id);
    if (!item) throw new Error(`Unknown memory item: ${id}`);
    item.pinned = true;
    item.confidence = Math.max(item.confidence, 0.9);
    writeJsonAtomic(memoryPath(repoPath), state);
    return item;
  });
}

export function forgetMemory(repoPath: string, id: string): void {
  withLock(repoPath, "memory", () => {
    const state = loadState(repoPath);
    if (!state.items.some((i) => i.id === id)) throw new Error(`Unknown memory item: ${id}`);
    state.items = state.items.filter((i) => i.id !== id);
    writeJsonAtomic(memoryPath(repoPath), state);
  });
}

// An item passes when its shell predicate (if any) exits 0 AND at least one of
// its scoped literal paths still exists. Items with neither check always pass —
// they cannot go stale detectably, only decay by curation.
function itemHolds(repoPath: string, item: MemoryItem): boolean {
  if (item.verify) {
    try {
      execFileSync("/bin/sh", ["-c", item.verify], {
        cwd: repoPath,
        timeout: VERIFY_TIMEOUT_MS,
        stdio: "ignore",
      });
    } catch {
      return false;
    }
  }
  const literals = (item.files ?? []).filter((f) => !f.includes("*"));
  if (literals.length > 0 && !literals.some((f) => fs.existsSync(path.join(repoPath, f)))) {
    return false;
  }
  return true;
}

// Run verification over the whole store, persisting the consequences: passing
// items get a fresh lastVerified; failing items lose confidence and stay in the
// store (they may recover on re-proposal) unless they decay below the floor,
// which prunes them. Returns ONLY the items that passed this round — a failing
// item is never handed to the brief, even before it is pruned.
export function verifyMemory(repoPath: string): MemoryItem[] {
  return withLock(repoPath, "memory", () => {
    const state = loadState(repoPath);
    const passing: MemoryItem[] = [];
    const kept: MemoryItem[] = [];
    for (const item of state.items) {
      if (itemHolds(repoPath, item)) {
        item.lastVerified = nowIso();
        passing.push(item);
        kept.push(item);
        continue;
      }
      item.confidence = item.confidence * DECAY_ON_FAIL;
      if (item.pinned || item.confidence >= PRUNE_BELOW) kept.push(item);
    }
    state.items = kept;
    writeJsonAtomic(memoryPath(repoPath), state);
    return passing;
  });
}

// The prompt section. Verification runs first (so a stale item is never
// injected), then items are scoped — repo-wide items always apply; scoped items
// apply when their footprint overlaps the task's — ranked pinned-first by
// confidence, and cut at a hard character budget so the brief can never bloat
// a prompt. Returns "" when nothing applies.
export function memoryBrief(repoPath: string, taskFiles?: string[], budgetChars = 1200): string {
  const verified = verifyMemory(repoPath).filter((item) => {
    if (item.confidence < PRUNE_BELOW && !item.pinned) return false;
    if (!item.files || item.files.length === 0) return true;
    if (!taskFiles) return true;
    return item.files.some((f) => taskFiles.some((t) => pathsOverlap(f, t)));
  });
  verified.sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.confidence - a.confidence);

  const lines: string[] = [];
  let used = 0;
  for (const item of verified) {
    const line = `- [${item.kind}] ${item.text}`;
    if (used + line.length + 1 > budgetChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}
