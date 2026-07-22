import { crosstalk } from "./messages.ts";
import type { PoolState } from "./pool.ts";
import { listTasks, type TaskStatus } from "./tasks.ts";

// ── the bridge: a full-screen TUI renderer ────────────────────────────────────
// Pure function of state -> a frame (exactly `rows` lines, each exactly `cols`
// visible columns wide) plus where to park the cursor. The interactive driver
// in console.ts owns terminal I/O; this owns layout.
//
// Everything lives inside one rounded outer frame with interior padding, so
// nothing collides with the terminal edge. The centerpiece is the crew: one
// boxed pane per agent, side by side, updating at once — true parallelism is
// what you see.

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
  faint: fg(84, 98, 118),
  good: fg(123, 216, 143),
  warn: fg(226, 178, 94),
  bad: fg(230, 120, 120),
  rule: fg(58, 70, 88),
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

const ESC_RE = /\x1b\[[0-9;]*m/g;
function visLen(s: string): number {
  return s.replace(ESC_RE, "").length;
}

// Colored segments padded/truncated to exactly `width` visible columns.
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

// A box border line of exact visible width, with an optional left title and an
// optional right-aligned label embedded in the rule.
function edge(
  width: number,
  lc: string,
  rc: string,
  opts: { title?: string; titleColor?: string; right?: string; rightColor?: string } = {}
): string {
  const B = C.rule;
  const inner = width - 2;
  let mid = "";
  let used = 0;
  if (opts.title) {
    mid += "─ " + (opts.titleColor ?? C.text) + opts.title + RESET + B + " ";
    used += 3 + visLen(opts.title);
  }
  let rightStr = "";
  if (opts.right) {
    rightStr = " " + (opts.rightColor ?? C.dim) + opts.right + RESET + B + " ─";
    used += 3 + visLen(opts.right);
  }
  const fill = Math.max(0, inner - used);
  return B + lc + mid + "─".repeat(fill) + rightStr + B + rc + RESET;
}

// A body row inside a box: │ <content padded to width-4> │
function boxRow(width: number, parts: Part[]): string {
  return C.rule + "│" + RESET + " " + seg(width - 4, parts) + " " + C.rule + "│" + RESET;
}

// left-aligned parts with an optional right-aligned label, to exact width.
function lineLR(width: number, left: Part[], right?: string, rightColor?: string): string {
  const r = right ?? "";
  return seg(width - visLen(r), left) + (r ? (rightColor ?? C.dim) + r + RESET : "");
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
  busy: string | null;
  tokens: number;
};

export type Frame = { lines: string[]; cursorRow: number; cursorCol: number };

// One agent as a boxed pane: `width` × `height` lines. Title in the top border,
// recent activity anchored to the bottom, a counts footer.
function paneBox(pane: PoolState["panes"][number], width: number, height: number): string[] {
  const ac = agentColor(pane.agent);
  const busy = pane.phase === "working" || pane.phase === "verifying" || pane.phase === "claimed";
  const dot = busy ? "●" : "○";
  const title = `${dot} ${pane.agent}   ${PHASE[pane.phase] ?? pane.phase}${pane.taskId ? " " + pane.taskId : ""}`;

  const lines = [edge(width, "┌", "┐", { title, titleColor: ac + BOLD })];
  const bodyRows = Math.max(1, height - 3);

  const rows: string[] = [];
  if (pane.taskId && pane.taskTitle) rows.push(boxRow(width, [[pane.taskTitle, C.faint]]));
  for (const l of pane.lines) rows.push(boxRow(width, [[l, C.text]]));
  const shown = rows.slice(-bodyRows);
  const blanks = bodyRows - shown.length;
  for (let i = 0; i < blanks; i++) lines.push(boxRow(width, [["", C.text]]));
  for (const r of shown) lines.push(r);

  lines.push(
    boxRow(width, [
      [`${pane.completed} done`, C.dim],
      [pane.failed ? ` · ${pane.failed} failed` : "", C.bad],
      [pane.tokens ? ` · ${fmtTokens(pane.tokens)} tok` : "", C.faint],
    ])
  );
  lines.push(edge(width, "└", "┘", {}));
  return lines.slice(0, height);
}

export function renderBridge(repoPath: string, model: BridgeModel, cols: number, rows: number): Frame {
  const W = Math.max(60, cols);
  const H = Math.max(18, rows);
  const IW = W - 4; // interior content width (outer borders + 1-col padding each side)
  const IH = H - 2; // interior rows

  const panes = model.state.panes;
  const online = panes.filter((p) => p.phase !== "idle").length;
  const stats = `${panes.length} agents · ${online} active · ${fmtElapsed(Date.now() - model.state.startedAt)} · ${fmtTokens(model.tokens)} tok`;

  // ── interior sections (each exactly IW visible) ──────────────────────────
  const body: string[] = [];
  const blank = () => seg(IW, [["", C.text]]);

  body.push(blank());

  // board strip
  const tasks = listTasks(repoPath);
  const done = tasks.filter((t) => t.status === "done").length;
  const glyphs: Part[] = [["board  ", C.dim]];
  if (tasks.length === 0) glyphs.push(["(empty — give the conductor a command)", C.faint]);
  for (const t of tasks.slice(-18)) {
    const color =
      t.status === "done" ? C.good : t.status === "failed" ? C.bad : t.status === "pending" ? C.faint : C.brass;
    glyphs.push([STATUS_GLYPH[t.status] + t.id.replace("task-", "") + " ", color]);
  }
  body.push(lineLR(IW, glyphs, tasks.length ? `${done}/${tasks.length} done` : undefined, C.dim));
  body.push(blank());

  // crew strip: N boxed panes side by side, spanning IW
  const bottomRows = 8; // blank, crosstalk head, 2 msgs, blank, rule, prompt, hint
  const crewH = Math.max(4, IH - 3 - bottomRows);
  const n = Math.max(1, panes.length);
  const gap = 2;
  const baseW = Math.floor((IW - (n - 1) * gap) / n);
  const widths = Array.from({ length: n }, (_, i) => baseW);
  widths[n - 1] += IW - (baseW * n + (n - 1) * gap); // absorb rounding into the last pane
  const boxes = panes.map((p, i) => paneBox(p, widths[i], crewH));
  for (let r = 0; r < crewH; r++) {
    let row = "";
    for (let i = 0; i < n; i++) {
      row += boxes[i][r] ?? " ".repeat(widths[i]);
      if (i < n - 1) row += " ".repeat(gap);
    }
    body.push(row);
  }

  body.push(blank());

  // crosstalk
  body.push(seg(IW, [["crosstalk", C.dim]]));
  const talk = crosstalk(repoPath, 2);
  for (let i = 0; i < 2; i++) {
    const m = talk[talk.length - 2 + i];
    if (!m) { body.push(blank()); continue; }
    const toCol = m.to === "captain" ? C.warn : agentColor(m.to);
    body.push(
      seg(IW, [
        [m.from, agentColor(m.from)],
        [" → ", C.faint],
        [m.to, toCol],
        ["  " + m.body, m.to === "captain" ? C.warn : C.text],
      ])
    );
  }
  body.push(blank());

  // input
  body.push(C.rule + "─".repeat(IW) + RESET);
  const prompt = model.busy ? "◇ " : "› ";
  const promptColor = model.busy ? C.dim : C.brass;
  const field = IW - 2;
  const raw = model.busy ?? model.input;
  const shown = raw.length > field ? raw.slice(-field) : raw;
  const promptIndex = body.length;
  body.push(seg(IW, [[prompt, promptColor], [shown, model.busy ? C.dim : C.text]]));
  body.push(seg(IW, [["enter send · /quit exit · ctrl-c stop", C.faint]]));

  // pad/trim interior to exactly IH
  while (body.length < IH) body.splice(promptIndex, 0, blank());
  const interior = body.slice(0, IH);
  const promptRow = Math.min(promptIndex, IH - 1);

  // ── wrap in the outer frame ──────────────────────────────────────────────
  const lines: string[] = [];
  lines.push(edge(W, "╭", "╮", { title: "WARDROOM · " + model.project, titleColor: C.brass + BOLD, right: stats, rightColor: C.faint }));
  for (const c of interior) lines.push(C.rule + "│" + RESET + " " + c + " " + C.rule + "│" + RESET);
  lines.push(edge(W, "╰", "╯", {}));

  // cursor: 1-indexed, parked after the typed text in the input row
  const cursorRow = 1 + promptRow + 1;
  const cursorCol = 3 + prompt.length + Math.min(shown.length, field); // outer│ + pad + prompt
  return { lines: lines.slice(0, H), cursorRow, cursorCol };
}
