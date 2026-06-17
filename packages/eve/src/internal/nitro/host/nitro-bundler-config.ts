import { createNodeEsmCompatBannerPlugin } from "#internal/node-esm-compat-banner.js";

interface BundlerLog {
  readonly id?: string;
  readonly ids?: readonly unknown[];
  readonly loc?: {
    readonly file?: string;
  };
  readonly pluginCode?: unknown;
}

type BundlerDefaultLogHandler = (level: string, log: unknown) => void;

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

  return [
    candidate.id,
    ...ids,
    candidate.loc?.file,
    typeof candidate.pluginCode === "string" ? candidate.pluginCode : undefined,
  ].filter((value): value is string => typeof value === "string");
}

function isVendoredDependencyWarning(log: unknown): boolean {
  return getLogFilePaths(log).some(
    (filePath) => isNodeModulesPath(filePath) || isCompiledVendorPath(filePath),
  );
}

function onNitroBundlerLog(
  level: string,
  log: unknown,
  defaultHandler: BundlerDefaultLogHandler,
): void {
  if (level === "warn" && isVendoredDependencyWarning(log)) {
    return;
  }

  defaultHandler(level, log);
}

/**
 * Creates eve-owned Nitro bundler overrides that must apply to both Rollup
 * and Rolldown hosted builds.
 */
export function createNitroBundlerConfig(plugins: readonly object[]): Record<string, unknown> {
  return {
    onLog: onNitroBundlerLog,
    plugins: [createNodeEsmCompatBannerPlugin(), ...plugins],
  };
}
