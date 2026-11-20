import type { Approval } from "#approval/definition.js";
import type { ConnectionClient } from "#shared/connection-types.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";

export interface ConnectionRegistry {
  dispose(): Promise<void>;
  getClient(connectionName: string): ConnectionClient;
  getConnectionApproval(connectionName: string): Approval | undefined;
  getConnectionNames(): readonly string[];
  getConnections(): readonly ResolvedConnectionDefinition[];
}
