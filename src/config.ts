import fs from "fs";
import path from "path";

// ── wardroom.json ─────────────────────────────────────────────────────────────
// Per-repo configuration for the harness. Everything CLI-specific (binary,
// flags, permission model) lives HERE and in the adapters — nothing above the
// adapter layer knows how a particular agent CLI is invoked.
//
// The permission flags in the defaults are deliberately conservative: workers
// get whatever the user configured, and adapters fail loudly when a CLI stalls
// waiting for interactive approval (see docs/plan.md, risks).

export type AgentConfig = {
  adapter: "claude" | "codex" | "gemini";
  bin: string;
  args: string[];
  role?: string;
};

export type WardroomConfig = {
  agents: Record<string, AgentConfig>;
  verify?: string;
  taskTimeoutMinutes: number;
};

const DEFAULTS: WardroomConfig = {
  agents: {
    claude: {
      adapter: "claude",
      bin: "claude",
      args: ["-p", "--output-format", "stream-json", "--verbose"],
    },
    codex: {
      adapter: "codex",
      bin: "codex",
      args: ["exec", "--json"],
    },
    gemini: {
      adapter: "gemini",
      bin: "gemini",
      args: ["-p"],
    },
  },
  taskTimeoutMinutes: 20,
};

export function loadConfig(repoPath: string): WardroomConfig {
  const file = path.join(repoPath, "wardroom.json");
  if (!fs.existsSync(file)) {
    return structuredClone(DEFAULTS);
  }

  let parsed: Partial<WardroomConfig>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`wardroom.json is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }

  const config: WardroomConfig = {
    ...structuredClone(DEFAULTS),
    ...parsed,
    agents: { ...structuredClone(DEFAULTS.agents), ...(parsed.agents ?? {}) },
  };

  for (const [name, agent] of Object.entries(config.agents)) {
    if (!agent.bin || !agent.adapter) {
      throw new Error(`wardroom.json agent "${name}" needs "adapter" and "bin"`);
    }
    if (!["claude", "codex", "gemini"].includes(agent.adapter)) {
      throw new Error(`wardroom.json agent "${name}": unknown adapter "${agent.adapter}"`);
    }
  }

  return config;
}
