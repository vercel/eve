function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function isNodeModulesPath(filePath) {
  return normalizePath(filePath).split("/").includes("node_modules");
}

function hasPathSegments(filePath, segments) {
  const pathSegments = normalizePath(filePath).split("/").filter(Boolean);
  return pathSegments.some((_, index) =>
    segments.every((segment, offset) => pathSegments[index + offset] === segment),
  );
}

function isCompiledVendorPath(filePath) {
  return (
    hasPathSegments(filePath, [".generated", "compiled"]) ||
    hasPathSegments(filePath, ["dist", "src", "compiled"])
  );
}

function getLogFilePaths(log) {
  if (typeof log === "string") {
    return [];
  }

  return [
    log.id,
    ...(log.ids ?? []),
    log.loc?.file,
    typeof log.pluginCode === "string" ? log.pluginCode : undefined,
  ].filter((value) => typeof value === "string");
}

function isVendoredDependencyWarning(log) {
  return getLogFilePaths(log).some(
    (filePath) => isNodeModulesPath(filePath) || isCompiledVendorPath(filePath),
  );
}

export function createVendoredDependencyWarningFilter() {
  return {
    onLog(level, log, defaultHandler) {
      if (level === "warn" && isVendoredDependencyWarning(log)) {
        return;
      }

      defaultHandler(level, log);
    },
  };
}
