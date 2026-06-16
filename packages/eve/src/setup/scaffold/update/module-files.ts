export const SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS = [
  ".cts",
  ".mts",
  ".cjs",
  ".mjs",
  ".ts",
  ".js",
] as const;

export function getSupportedModuleBaseName(name: string): string | null {
  for (const extension of SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS) {
    if (name.endsWith(extension) && name.length > extension.length) {
      return name.slice(0, -extension.length);
    }
  }

  return null;
}

export function matchesSupportedModuleBaseName(name: string, baseName: string): boolean {
  return getSupportedModuleBaseName(name) === baseName;
}
