import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { load } from "js-yaml";

async function readWorkspace(start) {
  let directory = resolve(start);
  while (true) {
    try {
      return load(await readFile(join(directory, "pnpm-workspace.yaml"), "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return {};
    directory = parent;
  }
}

export async function resolveCatalogReferences(packageRoot, manifest) {
  const types = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  const rewritten = structuredClone(manifest);
  let workspace;
  let rewrote = false;
  for (const type of types) {
    for (const [name, range] of Object.entries(rewritten[type] ?? {})) {
      if (typeof range !== "string" || !range.startsWith("catalog:")) continue;
      workspace ??= await readWorkspace(packageRoot);
      const catalogName = range.slice("catalog:".length);
      const catalog = catalogName ? workspace?.catalogs?.[catalogName] : workspace?.catalog;
      const value = catalog?.[name];
      if (typeof value !== "string" || !value) {
        throw new Error(
          `Dependency "${name}" in "${packageRoot}/package.json" uses "${range}" but is not defined in the workspace catalog.`,
        );
      }
      rewritten[type][name] = value;
      rewrote = true;
    }
  }
  return { manifest: rewritten, rewrote };
}
