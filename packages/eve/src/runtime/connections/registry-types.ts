import type { Approval } from "#approval/definition.js";
import type { ConnectionClient } from "#shared/connection-types.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";

/**
 * Per-step container mapping compiled connection names to live clients. The
 * step that creates it disposes it when the step ends.
 */
export interface ConnectionRegistry {
  dispose(): Promise<void>;
  getClient(connectionName: string): ConnectionClient;
  getConnectionApproval(connectionName: string): Approval | undefined;
  getConnectionNames(): readonly string[];
  getConnections(): readonly ResolvedConnectionDefinition[];
}
