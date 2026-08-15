const DEFAULT_VALUE_LENGTH = 160;

/** Adds an optional user label without replacing the assertion's stable family name. */
export function formatAssertionName(name: string, label: string): string {
  const normalized = label.trim();
  if (normalized.length === 0) {
    throw new Error("Assertion labels must be non-empty.");
  }
  return `${name} [${normalized}]`;
}

/** Formats an assertion value for a compact human-readable diagnostic. */
export function formatDiagnosticValue(value: unknown, maxLength = DEFAULT_VALUE_LENGTH): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return truncateDiagnostic(text, maxLength);
}

/** Converts arbitrary assertion evidence into an artifact-safe JSON value. */
export function toDiagnosticMetadataValue(value: unknown): unknown {
  const ancestors: object[] = [];
  try {
    const json = JSON.stringify(value, function (this: object, _key, current: unknown) {
      if (typeof current === "bigint") return `${String(current)}n`;
      if (typeof current === "function" || typeof current === "symbol") return String(current);
      if (current instanceof Error) {
        return { name: current.name, message: current.message, stack: current.stack };
      }
      if (current !== null && typeof current === "object") {
        // Shared references are valid; only objects on the active traversal path are circular.
        while (ancestors.length > 0 && ancestors.at(-1) !== this) {
          ancestors.pop();
        }
        if (ancestors.includes(current)) return "[Circular]";
        ancestors.push(current);
      }
      return current;
    });
    return json === undefined ? String(value) : (JSON.parse(json) as unknown);
  } catch {
    return String(value);
  }
}

/** Bounds diagnostic text while leaving full structured evidence in metadata. */
export function truncateDiagnostic(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}
