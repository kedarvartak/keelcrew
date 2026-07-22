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
  const H = Math.max(20, rows);
  const M = 2; // left/right margin so content never hugs the terminal edge
  const CW = W - M * 2; // content width

  const panes = model.state.panes;
  const tasks = listTasks(repoPath);
  const done = tasks.filter((t) => t.status === "done").length;

  // Each entry is a content line exactly CW visible; margins are added at wrap.
  const body: string[] = [];
  const blank = () => seg(CW, [["", C.text]]);

  body.push(blank());

  // board strip — the only status line (no branded header). Stats ride on its
  // right edge so nothing is lost by dropping the header.
  const glyphs: Part[] = [["board  ", C.dim]];
  if (tasks.length === 0) glyphs.push(["give the conductor a command below", C.faint]);
  for (const t of tasks.slice(-18)) {
    const color =
      t.status === "done" ? C.good : t.status === "failed" ? C.bad : t.status === "pending" ? C.faint : C.brass;
    glyphs.push([STATUS_GLYPH[t.status] + t.id.replace("task-", "") + " ", color]);
  }
  const right = `${fmtElapsed(Date.now() - model.state.startedAt)} · ${fmtTokens(model.tokens)} tok${tasks.length ? ` · ${done}/${tasks.length} done` : ""}`;
  body.push(lineLR(CW, glyphs, right, C.faint));
  body.push(blank());

  // How many rows the fixed lower sections need, so the crew fills the rest.
  const CHAT_BOTTOM_PAD = 3; // Claude-Code-style breathing room under the input
  const fixedLower =
    1 /*blank*/ + 1 /*crosstalk head*/ + 2 /*msgs*/ + 1 /*blank*/ + 3 /*chat box*/ + 1 /*hint*/ + CHAT_BOTTOM_PAD;
  const usedTop = body.length; // blank + board + blank
  const crewH = Math.max(4, H - usedTop - fixedLower);

  // crew strip: N boxed panes side by side, spanning CW
  const n = Math.max(1, panes.length);
  const gap = 2;
  const baseW = Math.floor((CW - (n - 1) * gap) / n);
  const widths = Array.from({ length: n }, () => baseW);
  widths[n - 1] += CW - (baseW * n + (n - 1) * gap);
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
  body.push(seg(CW, [["crosstalk", C.dim]]));
  const talk = crosstalk(repoPath, 2);
  for (let i = 0; i < 2; i++) {
    const m = talk[talk.length - 2 + i];
    if (!m) { body.push(blank()); continue; }
    const toCol = m.to === "captain" ? C.warn : agentColor(m.to);
    body.push(
      seg(CW, [
        [m.from, agentColor(m.from)],
        [" → ", C.faint],
        [m.to, toCol],
        ["  " + m.body, m.to === "captain" ? C.warn : C.text],
      ])
    );
  }
  body.push(blank());

  // ── chat bar: a rounded input box, then a dim hint ───────────────────────
  const prompt = model.busy ? "◇ " : "› ";
  const promptColor = model.busy ? C.dim : C.brass;
  const field = CW - 6; // box borders(2) + pads(2) + prompt(2)
  const raw = model.busy ?? model.input;
  const shown = raw.length > field ? raw.slice(-field) : raw;

  body.push(edge(CW, "╭", "╮", {}));
  body.push(boxRow(CW, [[prompt, promptColor], [shown, model.busy ? C.dim : C.text]]));
  body.push(edge(CW, "╰", "╯", {}));
  body.push(seg(CW, [["  enter send · /quit exit · ctrl-c stop", C.faint]]));
  for (let i = 0; i < CHAT_BOTTOM_PAD; i++) body.push(blank());

  const lines = body.slice(0, H).map((c) => " ".repeat(M) + c + " ".repeat(M));

  // cursor: 1-indexed. The chat box sits a fixed distance from the bottom:
  // box-bottom + hint + CHAT_BOTTOM_PAD rows follow the input row.
  const cursorRow = H - (CHAT_BOTTOM_PAD + 2);
  const cursorCol = M + 5 + Math.min(shown.length, field); // margin + "│ › "
  return { lines, cursorRow, cursorCol };
}
