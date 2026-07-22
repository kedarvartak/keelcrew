import readline from "readline";
import type { AgentEvent } from "./adapters/types.ts";
import type { WardroomConfig } from "./config.ts";
import { sendMessage } from "./messages.ts";
import type { PoolState } from "./pool.ts";
import { startSession } from "./session.ts";
import { renderBoard } from "./tasks.ts";

// ── the interactive console ───────────────────────────────────────────────────
// One terminal. You type commands to the conductor; the crew works in the
// background and its activity streams above a persistent prompt. This is the
// front the whole project was built for: "command it like you normally do."
//
// Presentation is a live log above a readline prompt (robust in any terminal)
// rather than a fixed-pane TUI: every status/agent line is printed above the
// input line, which is re-rendered preserving whatever you're mid-typing.

const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const HELP = `commands:
  <anything>        a command for the conductor (it dispatches the crew)
  /board            show the full task board
  /say <msg>        message the crew as the captain (answer a question)
  /help             this help
  /quit             stop the crew and exit`;

export async function runConsole(repoPath: string, crew: string[], config: WardroomConfig): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt(`${BOLD}wardroom>${RESET} `);

  // Print a line above the prompt without eating the user's in-progress input.
  const log = (line: string) => {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(line + "\n");
    rl.prompt(true);
  };

  let lastPhase = new Map<string, string>();
  const onChange = (state: PoolState) => {
    // Only announce phase transitions, so the log doesn't flood.
    for (const pane of state.panes) {
      const key = `${pane.phase}:${pane.taskId ?? ""}`;
      if (lastPhase.get(pane.agent) !== key) {
        lastPhase.set(pane.agent, key);
        if (pane.phase === "working" && pane.taskId) {
          log(`${CYAN}${pane.agent}${RESET} ${DIM}started ${pane.taskId}: ${pane.taskTitle ?? ""}${RESET}`);
        } else if (pane.phase === "done" && pane.taskId) {
          log(`${GREEN}${pane.agent}${RESET} ${DIM}finished ${pane.taskId}${RESET}`);
        }
      }
    }
  };
  const onLine = (agent: string, taskId: string, event: AgentEvent) => {
    if (event.kind === "text") log(`  ${CYAN}${agent}${RESET} ${event.text}`);
    else if (event.kind === "tool") log(`  ${CYAN}${agent}${RESET} ${DIM}${event.detail}${RESET}`);
    else if (event.kind === "result" && !event.ok) log(`  ${YELLOW}${agent}: ${event.summary}${RESET}`);
  };

  const session = startSession(repoPath, crew, config, { onChange, onLine });

  process.stdout.write(
    `${BOLD}WARDROOM${RESET} — conductor ready. Crew: ${crew.join(", ")}.\n` +
      `${DIM}Type a command for the conductor, or /help. Ctrl-C or /quit to stop.${RESET}\n\n`
  );
  rl.prompt();

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`\n${DIM}stopping the crew...${RESET}\n`);
    const result = await session.stop();
    process.stdout.write(
      `${result.completed} task(s) done, ${result.failed} failed this session` +
        (result.writedownFile ? ` — writedown: ${result.writedownFile}` : "") +
        "\n"
    );
    rl.close();
    process.exit(0);
  };

  rl.on("line", async (raw) => {
    const input = raw.trim();
    if (!input) return rl.prompt();

    if (input === "/quit" || input === "/exit") return void shutdown();
    if (input === "/help") {
      log(HELP);
      return rl.prompt();
    }
    if (input === "/board") {
      log(renderBoard(repoPath));
      return rl.prompt();
    }
    if (input.startsWith("/say ")) {
      const msg = input.slice(5).trim();
      if (msg) {
        sendMessage(repoPath, "captain", "all", msg);
        log(`${DIM}(sent to crew)${RESET}`);
      }
      return rl.prompt();
    }

    // Otherwise: a command for the conductor.
    log(`${DIM}conductor: interpreting...${RESET}`);
    try {
      const { created, note } = await session.command(input);
      if (created.length > 0) {
        log(`${GREEN}conductor dispatched ${created.length} task(s):${RESET}`);
        for (const t of created) {
          log(`  ${t.id} ${t.title}${t.assignee ? ` ${CYAN}@${t.assignee}${RESET}` : ""}`);
        }
      } else {
        log(`${DIM}conductor: ${note ?? "nothing to do"}${RESET}`);
      }
    } catch (error) {
      log(`${YELLOW}conductor error: ${error instanceof Error ? error.message : error}${RESET}`);
    }
    rl.prompt();
  });

  rl.on("SIGINT", () => void shutdown());
}
