/** Serializes protocol artifacts independently of constructor/schema property order. */
export function serializeArtifactJson(value: unknown): string {
  return `${JSON.stringify(canonicalizeArtifactJsonValue(value), null, 2)}\n`;
}

export function canonicalizeArtifactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeArtifactJsonValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareArtifactKeys(left, right))
      .map(([key, entry]) => [key, canonicalizeArtifactJsonValue(entry)]),
  );
}

function compareArtifactKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
