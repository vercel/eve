import type { ConnectionProtocol } from "#shared/connection-types.js";

/**
 * Cross-instance symbol marking which protocol a connection definition
 * speaks. Stamped by the `define*` factory at module-load time and read
 * by the compiler to choose the right normalizer. `Symbol.for` ensures
 * the resolution pipeline's module copy and the author's import share
 * the same property key, and using a symbol keeps the marker invisible
 * to the `Object.keys`-based authored-shape validators.
 */
const PROTOCOL_KEY = Symbol.for("eve.connection-protocol");

/**
 * Stamps the wire protocol on a connection definition. Called by the
 * `define*` factory that produced it.
 */
export function stampConnectionProtocol(definition: object, protocol: ConnectionProtocol): void {
  Object.defineProperty(definition, PROTOCOL_KEY, { configurable: true, value: protocol });
}

/**
 * Reads the stamped protocol from a connection definition, defaulting
 * to `"mcp"` when unstamped so connection modules authored before the
 * marker existed continue to compile as MCP connections.
 */
export function readConnectionProtocol(definition: unknown): ConnectionProtocol {
  return readStampedConnectionProtocol(definition) ?? "mcp";
}

/**
 * Reads the protocol marker without applying the legacy MCP fallback.
 * Dynamic connection resolvers use this to distinguish one branded
 * connection definition from a map of branded definitions.
 */
export function readStampedConnectionProtocol(definition: unknown): ConnectionProtocol | undefined {
  if (typeof definition !== "object" || definition === null || !(PROTOCOL_KEY in definition)) {
    return undefined;
  }
  return (definition as Record<symbol, ConnectionProtocol | undefined>)[PROTOCOL_KEY];
}
