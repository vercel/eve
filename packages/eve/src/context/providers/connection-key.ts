import { ContextKey } from "#context/key.js";
import type { ConnectionRegistry } from "#runtime/connections/types.js";

/**
 * Context key for the per-session connection registry.
 *
 * Defined separately from the provider so framework tools can read the key
 * without importing connection client setup into the framework-tools bundle.
 */
export const ConnectionRegistryKey = new ContextKey<ConnectionRegistry>("eve.connectionRegistry");
