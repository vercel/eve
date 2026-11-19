import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export function resolveEveBinaryPath(appRoot: string): string {
  try {
    const require = createRequire(join(appRoot, "package.json"));
    return join(dirname(require.resolve("eve/package.json")), "bin", "eve.js");
  } catch {
    return join(appRoot, "node_modules", "eve", "bin", "eve.js");
  }
}
