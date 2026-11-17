import type { ConnectionProtocol } from "#shared/connection-types.js";

const PROTOCOL_KEY = Symbol.for("eve.connection-protocol");

export function stampConnectionProtocol(definition: object, protocol: ConnectionProtocol): void {
  Object.defineProperty(definition, PROTOCOL_KEY, { configurable: true, value: protocol });
}

export function readStampedConnectionProtocol(definition: unknown): ConnectionProtocol | undefined {
  if (typeof definition !== "object" || definition === null || !(PROTOCOL_KEY in definition)) {
    return undefined;
  }
  return (definition as Record<symbol, ConnectionProtocol | undefined>)[PROTOCOL_KEY];
}
