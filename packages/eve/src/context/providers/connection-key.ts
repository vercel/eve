import { ContextKey } from "#context/key.js";
import type { ConnectionRegistry } from "#shared/connections.js";

/**
 * Context key for the per-session connection registry.
 *
 * Defined separately from the provider so connection-backed tools can read the
 * key without importing connection client setup into their execution module.
 */
export const ConnectionRegistryKey = new ContextKey<ConnectionRegistry>("eve.connectionRegistry");
