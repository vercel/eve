/** Authoring and distribution roots declared by an extension package. */
export interface ExtensionPackageRoots {
  /**
   * Authoring root. Optional so published packages can ship `dist` only;
   * `eve extension build` requires it.
   */
  readonly source?: string;
  readonly dist: string;
}

/** Parses the strict `package.json#eve.extension` object contract. */
export function parseExtensionPackageRoots(value: unknown): ExtensionPackageRoots | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.dist !== "string" || record.dist.length === 0) return null;
  if (record.source === undefined) return { dist: record.dist };
  return typeof record.source === "string" && record.source.length > 0
    ? { source: record.source, dist: record.dist }
    : null;
}
