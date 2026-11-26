export function prepareFilePathAlias(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (
    (Object.hasOwn(record, "filePath") && record.filePath !== undefined) ||
    typeof record.path !== "string"
  ) {
    return input;
  }
  const { path, ...rest } = record;
  return { ...rest, filePath: path };
}
