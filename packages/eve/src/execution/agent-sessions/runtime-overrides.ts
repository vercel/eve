import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";

/** Invocation-bound configuration applied after the target agent is resolved. */
export interface AgentSessionRuntimeOverrides {
  readonly model: RuntimeModelReference;
}
