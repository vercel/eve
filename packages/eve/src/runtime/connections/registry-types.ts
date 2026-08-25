import type { Approval } from "#public/definitions/approval.js";
import type { ConnectionClient } from "#shared/connection-types.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";

/** Per-session container mapping compiled connection names to live clients. */
export interface ConnectionRegistry {
  dispose(): Promise<void>;
  getClient(connectionName: string): ConnectionClient;
  getConnectionApproval(connectionName: string): Approval | undefined;
  getConnectionNames(): readonly string[];
  getConnections(): readonly ResolvedConnectionDefinition[];
}
