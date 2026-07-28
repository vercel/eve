import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Resolves the absolute path to the installed eve binary from the app's
 * perspective.
 *
 * Uses module resolution rather than assuming an app-local `node_modules/eve`:
 * npm workspaces hoist eve to the workspace root, so the app-local path does
 * not exist there, while pnpm symlinks it app-locally. eve does not export
 * `./bin/eve.js`, but it does export `./package.json`, so we resolve that and
 * derive the bin path from the package root. Falls back to the conventional
 * app-local path when eve cannot be resolved (e.g. before install).
 */
export function resolveEveBinaryPath(nextRoot: string): string {
  try {
    const require = createRequire(join(nextRoot, "package.json"));
    return join(dirname(require.resolve("eve/package.json")), "bin", "eve.js");
  } catch {
    return join(nextRoot, "node_modules", "eve", "bin", "eve.js");
  }
}
