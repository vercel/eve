import { accessSync, constants, realpathSync } from "node:fs";
import { basename, delimiter, join } from "node:path";

interface NodeExecutableRuntime {
  readonly execPath: string;
  readonly isBun: boolean;
  readonly path: string | undefined;
  readonly platform: NodeJS.Platform;
}

function currentRuntime(): NodeExecutableRuntime {
  return {
    execPath: process.execPath,
    isBun: process.versions.bun !== undefined,
    path: process.env.PATH ?? process.env.Path,
    platform: process.platform,
  };
}

function realpathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Node.js executable that framework integrations use to spawn `eve dev`,
 * which only runs under Node. Under `bun --bun`, `process.execPath` is Bun and
 * Bun prepends a `bun-node-*` PATH directory whose `node` links back to Bun,
 * so a real Node.js is found by skipping anything that resolves to Bun.
 */
export function resolveNodeExecutable(runtime: NodeExecutableRuntime = currentRuntime()): string {
  if (!runtime.isBun) {
    return runtime.execPath;
  }

  const bunExecutable = realpathOrUndefined(runtime.execPath) ?? runtime.execPath;
  const nodeName = runtime.platform === "win32" ? "node.exe" : "node";

  for (const directory of (runtime.path ?? "").split(delimiter)) {
    if (directory === "" || basename(directory).startsWith("bun-node-")) {
      continue;
    }

    const candidate = join(directory, nodeName);
    const resolved = realpathOrUndefined(candidate);
    if (resolved !== undefined && resolved !== bunExecutable && isExecutable(resolved)) {
      return candidate;
    }
  }

  throw new Error(
    "eve's local dev server requires Node.js, but this process is running under Bun and no Node.js executable was found on PATH. Install Node.js, or start your framework dev server without `bun --bun`.",
  );
}
