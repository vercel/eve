import { ContextKey } from "#context/key.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";

export const ConnectionRegistryKey = new ContextKey<ConnectionRegistry>("eve.connectionRegistry");
