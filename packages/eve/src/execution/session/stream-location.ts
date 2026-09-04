interface StreamLocation {
  readonly runId: string;
  readonly namespace?: string;
}

/** The storage adapter alone interprets opaque stream and record IDs. */
export function encodeStreamLocation(location: StreamLocation): string {
  return JSON.stringify([location.runId, location.namespace ?? null]);
}

export function decodeStreamLocation(id: string): StreamLocation {
  const value: unknown = JSON.parse(id);
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    (value[1] !== null && typeof value[1] !== "string")
  ) {
    throw new Error("Invalid session storage reference.");
  }
  return { runId: value[0], namespace: value[1] ?? undefined };
}
