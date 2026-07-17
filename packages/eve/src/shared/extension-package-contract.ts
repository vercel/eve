/** Authoring and distribution roots declared by an extension package. */
export interface ExtensionPackageRoots {
  readonly source: string;
  readonly dist: string;
}

/** Parses the strict `package.json#eve.extension` object contract. */
export function parseExtensionPackageRoots(value: unknown): ExtensionPackageRoots | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return typeof record.source === "string" &&
    record.source.length > 0 &&
    typeof record.dist === "string" &&
    record.dist.length > 0
    ? { source: record.source, dist: record.dist }
    : null;
}
