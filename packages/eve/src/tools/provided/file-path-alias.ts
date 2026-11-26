export function prepareFilePathAlias(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (typeof record.filePath === "string" || typeof record.path !== "string") return input;
  const { path, ...rest } = record;
  return { ...rest, filePath: path };
}
