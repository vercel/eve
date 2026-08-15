function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Statically extracts the extension package specifier a mount file resolves to,
 * without importing the module. Discovery reads only the import that binds the
 * value the mount re-exports, so it can locate the package while honoring the
 * "never import authored modules" invariant.
 *
 * Supported mount forms:
 * - `export { default } from "@acme/crm";`
 * - `import { crm } from "@acme/crm"; export default crm({ ... });`
 * - `import crm from "@acme/crm"; export default crm();`
 *
 * Returns the specifier string, or `null` when the file does not match a
 * recognized mount shape.
 */
export function parseExtensionMountSpecifier(source: string): string | null {
  const reExport = source.match(/export\s*\{[^}]*\bdefault\b[^}]*\}\s*from\s*['"]([^'"]+)['"]/);
  if (reExport !== null) {
    return reExport[1] ?? null;
  }

  const factory = source.match(/export\s+default\s+([A-Za-z_$][\w$]*)\s*[(;\n]/);
  const boundName = factory?.[1];
  if (boundName === undefined) {
    return null;
  }

  const defaultImport = source.match(
    new RegExp(
      `import\\s+${escapeRegExp(boundName)}\\s*(?:,\\s*\\{[^}]*\\})?\\s*from\\s*['"]([^'"]+)['"]`,
    ),
  );
  if (defaultImport !== null) {
    return defaultImport[1] ?? null;
  }

  const namedImport = /import\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (let match = namedImport.exec(source); match !== null; match = namedImport.exec(source)) {
    const clause = match[1] ?? "";
    for (const entry of clause.split(",")) {
      const parts = entry.trim().split(/\s+as\s+/);
      const local = (parts[1] ?? parts[0] ?? "").trim();
      if (local === boundName) {
        return match[2] ?? null;
      }
    }
  }

  return null;
}
