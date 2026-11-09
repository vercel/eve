// eve's own streams use these prefixes, and a run's default stream holds eve's session records.
const RESERVED_STREAM_NAMESPACE_PREFIXES = ["eve.", "eve:"] as const;

/**
 * Validates the namespace of an application workflow stream. Runs inside replayed workflow bodies,
 * so it must stay free of Node.js APIs.
 */
export function applicationStreamNamespace(namespace: unknown): string {
  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new TypeError(
      "Workflow streams need a non-empty `namespace`: a run's default stream belongs to eve.",
    );
  }
  const reserved = RESERVED_STREAM_NAMESPACE_PREFIXES.find((prefix) =>
    namespace.startsWith(prefix),
  );
  if (reserved !== undefined) {
    throw new Error(
      `Workflow stream namespace "${namespace}" uses the reserved "${reserved}" prefix. Use an application-owned namespace instead.`,
    );
  }
  return namespace;
}
