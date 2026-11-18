function readNonEmptyStringField(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null || !(field in value)) return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

export function readVercelResourceName(value: unknown): string | undefined {
  return readNonEmptyStringField(value, "name") ?? readVercelResourceSlug(value);
}

export function readVercelResourceSlug(value: unknown): string | undefined {
  const slug = readNonEmptyStringField(value, "slug");
  return slug !== undefined && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) ? slug : undefined;
}
