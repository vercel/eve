import type { RunInput } from "#channel/types.js";

/** Framework-only run input used to inherit one Agent Run across local workflows. */
export interface AgentSessionRunInput extends RunInput {
  readonly agentSessionId?: string;
}
