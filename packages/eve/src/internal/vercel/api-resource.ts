function readNonEmptyStringField(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null || !(field in value)) return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/** Reads a Vercel resource's display name, falling back to its slug. */
export function readVercelResourceName(value: unknown): string | undefined {
  return readNonEmptyStringField(value, "name") ?? readVercelResourceSlug(value);
}

/** Reads a validated Vercel resource slug. */
export function readVercelResourceSlug(value: unknown): string | undefined {
  const slug = readNonEmptyStringField(value, "slug");
  return slug !== undefined && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) ? slug : undefined;
}
