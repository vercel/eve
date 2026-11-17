import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";

export interface AgentSessionRuntimeOverrides {
  readonly model: RuntimeModelReference;
}
