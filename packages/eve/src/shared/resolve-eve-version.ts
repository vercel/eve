import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export function resolveInstalledEveVersion(root: string): string | undefined {
  let manifestPath: string;
  try {
    manifestPath = createRequire(join(root, "package.json")).resolve("eve/package.json");
  } catch {
    return undefined;
  }
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  return manifest !== null &&
    typeof manifest === "object" &&
    "version" in manifest &&
    typeof manifest.version === "string"
    ? manifest.version
    : undefined;
}
