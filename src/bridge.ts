import path from "path";
import { crosstalk } from "./messages.ts";
import type { PoolState } from "./pool.ts";
import { listTasks, type TaskStatus } from "./tasks.ts";

// ── the bridge: a full-screen TUI renderer ────────────────────────────────────
// Pure function of state -> a frame (exactly `rows` lines, each exactly `cols`
// visible columns wide) plus where to park the cursor. The interactive driver
// in console.ts owns terminal I/O; this owns layout. Keeping it pure means the
// whole TUI is snapshot-testable.
//
// The centerpiece is the crew strip: one live pane per agent, side by side, so
// true parallelism is what you see — several coding agents working at once on
// one checkout.

const ESC = "\x1b[";
const RESET = ESC + "0m";
const BOLD = ESC + "1m";
const fg = (r: number, g: number, b: number) => `${ESC}38;2;${r};${g};${b}m`;

const C = {
  brass: fg(226, 178, 94),
  claude: fg(96, 202, 216),
  codex: fg(123, 216, 143),
  gemini: fg(180, 147, 255),
  talk: fg(184, 150, 255),
  text: fg(214, 223, 236),
  dim: fg(122, 137, 158),
  faint: fg(78, 92, 112),
  good: fg(123, 216, 143),
  warn: fg(226, 178, 94),
  bad: fg(230, 120, 120),
  rule: fg(45, 56, 72),
};

function agentColor(name: string): string {
  return { claude: C.claude, codex: C.codex, gemini: C.gemini }[name] ?? C.brass;
}

const STATUS_GLYPH: Record<TaskStatus, string> = {
  pending: "○",
  claimed: "◐",
  review: "◑",
  done: "●",
  failed: "✗",
};

const PHASE: Record<string, string> = {
  idle: "idle",
  waiting: "waiting",
  claimed: "claimed",
  working: "working",
  verifying: "verifying",
  done: "done",
  failed: "failed",
};

type Part = [text: string, color?: string];

// Build a run of colored segments padded/truncated to exactly `width` visible
// columns. Colors add no visible width; truncation adds an ellipsis.
function seg(width: number, parts: Part[]): string {
  let out = "";
  let vis = 0;
  for (const [text, color] of parts) {
    if (vis >= width) break;
    let t = String(text);
    if (vis + t.length > width) t = t.slice(0, Math.max(0, width - vis - 1)) + "…";
    out += (color ?? "") + t + (color ? RESET : "");
    vis += t.length;
  }
  if (vis < width) out += " ".repeat(width - vis);
  return out;
}

function rule(width: number): string {
  return C.rule + "─".repeat(width) + RESET;
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export type BridgeModel = {
  project: string;
  state: PoolState;
  input: string;
  busy: string | null; // e.g. "conductor: interpreting…" while a command runs
  tokens: number;
};

export type Frame = { lines: string[]; cursorRow: number; cursorCol: number };

// One agent's pane as `height` lines, each `width` visible cols.
function agentPane(pane: PoolState["panes"][number], width: number, height: number): string[] {
  const ac = agentColor(pane.agent);
  const busy = pane.phase === "working" || pane.phase === "verifying" || pane.phase === "claimed";
  const dot = busy ? "●" : "○";
  const lines: string[] = [];

  // header: ● claude   working task-3
  lines.push(
    seg(width, [
      [dot + " ", busy ? ac : C.faint],
      [pane.agent, ac + BOLD],
      ["  " + (PHASE[pane.phase] ?? pane.phase), C.dim],
      [pane.taskId ? " " + pane.taskId : "", C.faint],
    ])
  );
  // subtitle: current task title
  lines.push(seg(width, [[pane.taskId ? pane.taskTitle ?? "" : "—", C.faint]]));

  // body: recent activity anchored to the BOTTOM of the pane (just above the
  // footer), so the freshest line sits next to the action — reads as live.
  const bodyRows = Math.max(1, height - 3);
  const recent = pane.lines.slice(-bodyRows);
  for (let i = 0; i < bodyRows - recent.length; i++) lines.push(seg(width, [["", C.text]]));
  for (const l of recent) lines.push(seg(width, [["  " + l, C.text]]));

  // footer: counts + tokens
  lines.push(
    seg(width, [
      [`${pane.completed} done`, C.dim],
      [pane.failed ? ` · ${pane.failed} failed` : "", C.bad],
      [pane.tokens ? ` · ${fmtTokens(pane.tokens)} tok` : "", C.faint],
    ])
  );
  return lines.slice(0, height);
}

export function renderBridge(repoPath: string, model: BridgeModel, cols: number, rows: number): Frame {
  const W = Math.max(48, cols);
  const H = Math.max(16, rows);
  const lines: string[] = [];
  const panes = model.state.panes;

  // ── header bar ──────────────────────────────────────────────────────────
  const online = panes.filter((p) => p.phase !== "idle").length;
  const left: Part[] = [
    ["  ", C.text],
    ["WARDROOM", C.brass + BOLD],
    ["  " + model.project, C.dim],
  ];
  const right = `${panes.length} agents · ${online} active · ${fmtElapsed(Date.now() - model.state.startedAt)} · ${fmtTokens(model.tokens)} tok  `;
  lines.push(seg(W - right.length, left) + C.faint + right + RESET);

  // ── board strip ─────────────────────────────────────────────────────────
  const tasks = listTasks(repoPath);
  const done = tasks.filter((t) => t.status === "done").length;
  const glyphs: Part[] = [["  board  ", C.dim]];
  for (const t of tasks.slice(-16)) {
    const color =
      t.status === "done" ? C.good : t.status === "failed" ? C.bad : t.status === "pending" ? C.faint : C.brass;
    glyphs.push([STATUS_GLYPH[t.status] + t.id.replace("task-", "") + " ", color]);
  }
  if (tasks.length === 0) glyphs.push(["(empty — give the conductor a command)", C.faint]);
  const boardRight = tasks.length ? `${done}/${tasks.length} done  ` : "";
  lines.push(seg(W - boardRight.length, glyphs) + C.dim + boardRight + RESET);
  lines.push(rule(W));

  // ── crew strip (side-by-side agent panes) ───────────────────────────────
  // Reserve rows for header(2)+rule + crosstalk(1 head + ctRows) + input(3).
  const ctRows = 3;
  const fixedBelow = 1 /*rule*/ + 1 /*ct head*/ + ctRows + 3 /*input*/;
  const paneH = Math.max(4, H - lines.length - fixedBelow);
  const n = Math.max(1, panes.length);
  const sep = 3; // " │ "
  const colW = Math.max(14, Math.floor((W - (n - 1) * sep) / n));
  const columns = panes.map((p) => agentPane(p, colW, paneH));
  for (let r = 0; r < paneH; r++) {
    let row = "";
    for (let cI = 0; cI < n; cI++) {
      row += columns[cI][r] ?? " ".repeat(colW);
      if (cI < n - 1) row += C.rule + " │ " + RESET;
    }
    lines.push(padVisible(row, W));
  }
  lines.push(rule(W));

  // ── crosstalk ───────────────────────────────────────────────────────────
  lines.push(seg(W, [["  crosstalk", C.dim]]));
  const talk = crosstalk(repoPath, ctRows);
  for (let i = 0; i < ctRows; i++) {
    const m = talk[talk.length - ctRows + i];
    if (!m) {
      lines.push(seg(W, [["", C.text]]));
      continue;
    }
    const toCol = m.to === "captain" ? C.warn : agentColor(m.to);
    lines.push(
      seg(W, [
        ["  " + m.from, agentColor(m.from)],
        [" → ", C.faint],
        [m.to, toCol],
        ["  " + m.body, m.to === "captain" ? C.warn : C.text],
      ])
    );
  }

  // ── input box ───────────────────────────────────────────────────────────
  const prompt = model.busy ? "◇ " : "› ";
  const promptColor = model.busy ? C.dim : C.brass;
  const field = W - 6; // "│ " + prompt(2) + field + " │"
  const raw = model.busy ?? model.input;
  const shown = raw.length > field ? raw.slice(-field) : raw;

  const boxTop = C.rule + "╭" + "─".repeat(W - 2) + "╮" + RESET;
  const inputLine =
    C.rule + "│ " + RESET +
    promptColor + prompt + RESET +
    seg(field, [[shown, model.busy ? C.dim : C.text]]) +
    C.rule + " │" + RESET;
  const hintText = model.busy ? "  working…" : "  enter send · /quit exit · ctrl-c stop";
  const fill = Math.max(0, W - 2 - hintText.length);
  const boxBot = C.rule + "╰" + RESET + C.faint + hintText + RESET + C.rule + "─".repeat(fill) + "╯" + RESET;

  lines.push(boxTop, inputLine, boxBot);

  while (lines.length < H) lines.push(padVisible("", W));
  const frame = lines.slice(0, H);

  // 1-indexed cursor position, parked after the typed text in the input field.
  const cursorRow = H - 1; // input line is second from the bottom
  const cursorCol = 5 + Math.min(shown.length, field);
  return { lines: frame, cursorRow, cursorCol };
}

// Visible-length helpers that ignore ANSI escapes.
function visLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}
function padVisible(s: string, width: number): string {
  const v = visLen(s);
  return v < width ? s + " ".repeat(width - v) : s;
}
