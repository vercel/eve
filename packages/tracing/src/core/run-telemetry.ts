import type { AgentRun } from "../agent-run.js";
import type { AgentTelemetry } from "./types.js";

/**
 * Lets the AI SDK adapter reuse a run's telemetry and initialize OTel when needed.
 */
export const runTelemetry = new WeakMap<
  AgentRun,
  { telemetry: AgentTelemetry; usesGlobalProvider: boolean }
>();
