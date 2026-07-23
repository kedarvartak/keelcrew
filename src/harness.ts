// ── wardroom/harness ──────────────────────────────────────────────────────────
// The crew-running layer as an importable library: config, the keep-alive
// session (worker pool + live crew control), and the conductor. This is what
// lets ANOTHER harness embed wardroom's multi-agent capability wholesale —
// spawn the headless workers, dispatch conductor commands, control the crew —
// without our CLI in the loop. wardroom/core is the coordination protocol;
// this is the engine that drives a crew over it. Our own console (cli.ts →
// console.ts) consumes exactly this surface.

export { agentPreset, loadConfig, saveConfig, vendorFor, VENDORS } from "./config.ts";
export type { AgentConfig, ReviewPolicy, Vendor, WardroomConfig } from "./config.ts";

export { startSession } from "./session.ts";
export type { ControlResult, Session, SessionHooks } from "./session.ts";

export { runPool } from "./pool.ts";
export type { AgentPane, PoolControl, PoolHooks, PoolOptions, PoolResult, PoolState } from "./pool.ts";

export { interpretCommand } from "./conductor.ts";
export type { ConductorResult } from "./conductor.ts";

export { runWorker } from "./worker.ts";
export type { WorkerHooks, WorkerOptions, WorkerPhase, WorkerResult } from "./worker.ts";
