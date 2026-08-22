import { createHash } from "node:crypto";

/**
 * Content-independent module identity derived from the module path alone, so
 * ids minted at build time stay comparable across rebuilds that do not move
 * the file.
 */
export function stableModuleId(filename: string): string {
  let normalized = filename.replaceAll("\\", "/").replace(/[?#].*$/, "");
  const nodeModules = normalized.lastIndexOf("/node_modules/");
  if (nodeModules >= 0) {
    normalized = normalized.slice(nodeModules + "/node_modules/".length);
  } else {
    const cwd = process.cwd().replaceAll("\\", "/");
    if (normalized.startsWith(`${cwd}/`)) normalized = normalized.slice(cwd.length + 1);
  }

  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}
