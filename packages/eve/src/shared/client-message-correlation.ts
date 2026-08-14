const CLIENT_MESSAGE_ID_KEY = "clientMessageId";
const CLIENT_MESSAGE_IDS_KEY = "clientMessageIds";

/** Reads the framework-private id correlating one client send. */
export function readClientMessageId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[CLIENT_MESSAGE_ID_KEY];
  return typeof candidate === "string" ? candidate : undefined;
}

/** Reads framework-private ids propagated through one or more coalesced deliveries. */
export function readClientMessageIds(value: unknown): readonly string[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[CLIENT_MESSAGE_IDS_KEY];
  return Array.isArray(candidate) && candidate.every((id) => typeof id === "string")
    ? candidate
    : undefined;
}

/** Adds framework-private client-send correlation without exposing it in a public type. */
export function withClientMessageId<T extends object>(value: T, id: string | undefined): T {
  return id === undefined ? value : { ...value, [CLIENT_MESSAGE_ID_KEY]: id };
}

/** Adds framework-private delivery correlation without exposing it in a public type. */
export function withClientMessageIds<T extends object>(
  value: T,
  ids: readonly string[] | undefined,
): T {
  return ids === undefined ? value : { ...value, [CLIENT_MESSAGE_IDS_KEY]: ids };
}
