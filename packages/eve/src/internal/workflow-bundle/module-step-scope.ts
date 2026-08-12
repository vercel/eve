/**
 * Normalize a transform filename into a short, stable step-id scope.
 *
 * Dynamic-tool step ids live in a process-global registry. Without a
 * per-module scope, independently transformed files (or pnpm-nested
 * dependency packages) that both emit `__eve_dynamic_exec_0` overwrite
 * each other and resume fails with "step function ... is not registered".
 */
export function moduleStepScope(filename: string): string {
  let normalized = String(filename ?? "").replace(/\\/g, "/");
  const nodeModulesIndex = normalized.indexOf("/node_modules/");

  if (nodeModulesIndex === -1) {
    const cwd = process.cwd().replace(/\\/g, "/");
    if (normalized.startsWith(`${cwd}/`)) {
      normalized = normalized.slice(cwd.length + 1);
    }
  } else {
    // Prefer the package path after the last pnpm nesting level so
    // `.pnpm/<pkg>@<ver>/node_modules/<pkg>/...` collapses to `<pkg>/...`.
    normalized = normalized
      .slice(nodeModulesIndex + "/node_modules/".length)
      .replace(/^\.pnpm\/[^/]+\/node_modules\//, "");
  }

  // FNV-1a 32-bit — short, stable across machines once the path is normalized.
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
