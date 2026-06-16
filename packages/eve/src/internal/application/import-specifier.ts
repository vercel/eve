const WINDOWS_DRIVE_ABSOLUTE_PATH_PATTERN = /^\/?[A-Za-z]:[\\/]/;
const WINDOWS_UNC_ABSOLUTE_PATH_PATTERN = /^\\\\[^\\]/;
const IMPORT_SPECIFIER_PATTERN =
  /(\b(?:from|import)\s*(?:\(\s*)?)(["'])([A-Za-z]:[\\/][^"'\n\r]*)\2/g;

function isWindowsAbsolutePath(path: string): boolean {
  return (
    WINDOWS_DRIVE_ABSOLUTE_PATH_PATTERN.test(path) || WINDOWS_UNC_ABSOLUTE_PATH_PATTERN.test(path)
  );
}

function convertWindowsPathToFileUrl(path: string): string {
  let normalizedPath = path.replaceAll("\\", "/");

  if (normalizedPath.startsWith("//")) {
    return new URL(`file:${normalizedPath}`).href;
  }

  if (/^\/[A-Za-z]:\//.test(normalizedPath)) {
    normalizedPath = normalizedPath.slice(1);
  }

  return new URL(`file:///${normalizedPath}`).href;
}

function splitPathSpecifierSuffix(specifier: string): { path: string; suffix: string } {
  const queryIndex = specifier.indexOf("?");
  const hashIndex = specifier.indexOf("#");
  const suffixIndex =
    queryIndex === -1 ? hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);

  if (suffixIndex === -1) {
    return { path: specifier, suffix: "" };
  }

  return {
    path: specifier.slice(0, suffixIndex),
    suffix: specifier.slice(suffixIndex),
  };
}

/**
 * Converts filesystem paths into ESM-safe import specifiers.
 *
 * Node's ESM loader rejects raw Windows absolute paths such as
 * `G:\app\handler.js` because the drive letter is parsed as a URL scheme.
 * Generated source should import filesystem targets through `file://` URLs
 * while leaving virtual, package, and relative specifiers usable by bundlers.
 */
export function normalizeEsmImportSpecifier(specifier: string): string {
  if (specifier.startsWith("file://")) {
    return specifier;
  }

  const { path, suffix } = splitPathSpecifierSuffix(specifier);

  if (isWindowsAbsolutePath(path)) {
    return `${convertWindowsPathToFileUrl(path)}${suffix}`;
  }

  return specifier.replaceAll("\\", "/");
}

/**
 * Serializes an import specifier for direct insertion into generated ESM code.
 */
export function stringifyEsmImportSpecifier(specifier: string): string {
  return JSON.stringify(normalizeEsmImportSpecifier(specifier));
}

/**
 * Rewrites generated ESM source containing raw Windows absolute imports.
 */
export function normalizeGeneratedEsmImportSpecifiers(source: string): string {
  return source.replace(
    IMPORT_SPECIFIER_PATTERN,
    (_match, prefix: string, quote: string, specifier: string) =>
      `${prefix}${quote}${normalizeEsmImportSpecifier(specifier)}${quote}`,
  );
}
