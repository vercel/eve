import { readdir, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import type { SandboxProviderFiles } from "#shared/sandbox-provider.js";

export function createSandboxProviderFiles(root: string): SandboxProviderFiles {
  const resolvedRoot = resolve(root);

  async function resolvePath(path: string): Promise<string> {
    const candidate = resolve(resolvedRoot, path);
    const relativePath = relative(resolvedRoot, candidate);
    if (relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..")) {
      return candidate;
    }
    throw new Error(`Sandbox provider file path escapes the authored sandbox root: ${path}`);
  }

  return {
    async list() {
      const entries = await readdir(resolvedRoot, { recursive: true, withFileTypes: true }).catch(
        (error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
          throw error;
        },
      );
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => relative(resolvedRoot, resolve(entry.parentPath, entry.name)))
        .sort();
    },
    async read(path) {
      const candidate = await resolvePath(path);
      const [canonicalRoot, canonical] = await Promise.all([
        realpath(resolvedRoot),
        realpath(candidate),
      ]);
      const relativePath = relative(canonicalRoot, canonical);
      if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
        throw new Error(
          `Sandbox provider file resolves outside the authored sandbox root: ${path}`,
        );
      }
      return await readFile(canonical);
    },
    async readText(path) {
      return Buffer.from(await this.read(path)).toString("utf8");
    },
  };
}
