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
 * - `import crm from "@acme/crm"; const mount = crm(); export { mount as default };`
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
  const boundName = factory?.[1] ?? emittedMountFactory(source);
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

function emittedMountFactory(source: string): string | undefined {
  const exports = /export\s*\{([^}]*)\}\s*(?:;|$)/g;
  for (const match of source.matchAll(exports)) {
    for (const entry of (match[1] ?? "").split(",")) {
      const alias = entry.trim().match(/^([A-Za-z_$][\w$]*)\s+as\s+default$/);
      if (alias === null) continue;
      const declaration = source.match(
        new RegExp(
          `\\b(?:const|let|var)\\s+${escapeRegExp(alias[1]!)}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*\\(`,
        ),
      );
      return declaration?.[1];
    }
  }
  return undefined;
}
