interface ExtensionPackageRoots {
  readonly source?: string;
  readonly dist: string;
  readonly externalDependencies?: readonly string[];
}

export function parseExtensionPackageRoots(value: unknown): ExtensionPackageRoots | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.dist !== "string" || record.dist.length === 0) return null;
  const externalDependencies = parseExternalDependencies(record.externalDependencies);
  if (externalDependencies === null) return null;
  const roots: { dist: string; externalDependencies?: readonly string[] } = {
    dist: record.dist,
  };
  if (externalDependencies !== undefined) {
    roots.externalDependencies = externalDependencies;
  }
  if (record.source === undefined) return roots;
  return typeof record.source === "string" && record.source.length > 0
    ? { ...roots, source: record.source }
    : null;
}

export function parseBuiltInExtensionPackageRoots(
  value: unknown,
  subpath: string,
): ExtensionPackageRoots | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return parseExtensionPackageRoots((value as Record<string, unknown>)[subpath]);
}

function parseExternalDependencies(value: unknown): readonly string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const dependencies = new Set<string>();
  for (const dependency of value) {
    if (typeof dependency !== "string" || dependency.length === 0) return null;
    dependencies.add(dependency);
  }
  return [...dependencies];
}
