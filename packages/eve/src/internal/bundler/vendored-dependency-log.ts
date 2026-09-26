interface BundlerLog {
  readonly code?: string;
  readonly id?: string;
  readonly ids?: readonly unknown[];
  readonly loc?: {
    readonly file?: string;
  };
}

export type BundlerDefaultLogHandler = (level: string, log: unknown) => void;

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function isNodeModulesPath(filePath: string): boolean {
  return normalizePath(filePath).split("/").includes("node_modules");
}

function hasPathSegments(filePath: string, segments: readonly string[]): boolean {
  const pathSegments = normalizePath(filePath).split("/").filter(Boolean);
  return pathSegments.some((_, index) =>
    segments.every((segment, offset) => pathSegments[index + offset] === segment),
  );
}

function isCompiledVendorPath(filePath: string): boolean {
  return (
    hasPathSegments(filePath, [".generated", "compiled"]) ||
    hasPathSegments(filePath, ["dist", "src", "compiled"])
  );
}

function getLogFilePaths(log: unknown): string[] {
  if (log === null || typeof log !== "object") {
    return [];
  }

  const candidate = log as BundlerLog;
  const ids = Array.isArray(candidate.ids) ? candidate.ids : [];

  return [candidate.id, ...ids, candidate.loc?.file].filter(
    (value): value is string => typeof value === "string",
  );
}

function isVendoredDependencyWarning(log: unknown): boolean {
  // An unresolved import is externalized and fails when the bundle loads, so
  // it stays visible even when a dependency raised it.
  if ((log as BundlerLog | null)?.code === "UNRESOLVED_IMPORT") {
    return false;
  }

  const filePaths = getLogFilePaths(log);
  return (
    filePaths.length > 0 &&
    filePaths.every((filePath) => isNodeModulesPath(filePath) || isCompiledVendorPath(filePath))
  );
}

/**
 * Rollup/Rolldown `onLog` handler that drops warnings raised only by
 * dependency code (`node_modules` or eve's compiled vendor modules), which the
 * user cannot act on, and forwards everything else, including unresolved
 * imports.
 */
export function onVendoredDependencyLog(
  level: string,
  log: unknown,
  defaultHandler: BundlerDefaultLogHandler,
): void {
  if (level === "warn" && isVendoredDependencyWarning(log)) {
    return;
  }

  defaultHandler(level, log);
}
