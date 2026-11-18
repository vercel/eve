import type { AgentRun } from "../agent-run.js";
import type { AgentTelemetry } from "./types.js";

export const runTelemetry = new WeakMap<
  AgentRun,
  { telemetry: AgentTelemetry; usesGlobalProvider: boolean }
>();
