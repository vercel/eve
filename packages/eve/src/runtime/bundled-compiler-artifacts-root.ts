import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMPILER_ARTIFACTS_ROOT_ENV = "EVE_COMPILER_ARTIFACTS_ROOT";

/** Resolves staged compiler resources beside a portable bundled Nitro output. */
export function resolveBundledCompilerArtifactsRoot(importMetaUrl: string): string | undefined {
  const configuredRoot = process.env[COMPILER_ARTIFACTS_ROOT_ENV];
  if (configuredRoot !== undefined && configuredRoot.length > 0) {
    return resolve(configuredRoot);
  }

  const candidates = [
    process.argv[1] === undefined
      ? undefined
      : join(dirname(resolve(process.argv[1])), "..", ".eve"),
    join(dirname(fileURLToPath(importMetaUrl)), "..", ".eve"),
    join(process.cwd(), ".output", ".eve"),
    join(process.cwd(), ".eve"),
  ].filter((path): path is string => path !== undefined);

  return candidates.find((path) => existsSync(join(path, "compile")));
}
