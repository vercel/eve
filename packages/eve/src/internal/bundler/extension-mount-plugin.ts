import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";

const MOUNT_QUERY = "?eve-mount=";

interface Mount {
  readonly mountId: string;
  readonly sourceRoot: string;
  readonly packageName: string;
  readonly specifier?: string;
  readonly mountSourcePath?: string;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

/** Isolates extension-owned source modules, but leaves ordinary dependencies shared. */
export function createExtensionMountPlugin(
  mounts: readonly Mount[],
  overridePaths: ReadonlyMap<string, string> = new Map(),
): Record<string, unknown> | null {
  if (mounts.length === 0) return null;
  const roots = mounts.map((mount) => ({ ...mount, root: canonical(mount.sourceRoot) }));
  const declarationPaths = new Map(
    roots
      .filter((mount) => mount.mountSourcePath !== undefined)
      .map((mount) => [canonical(resolve(mount.mountSourcePath!)), mount]),
  );
  const byId = new Map(roots.map((mount) => [mount.mountId, mount]));
  const overrideMounts = new Map(
    [...overridePaths].map(([path, id]) => [canonical(path), byId.get(id)]),
  );
  return {
    name: "eve-extension-mount",
    async resolveId(
      this: {
        resolve: (
          source: string,
          importer?: string,
          options?: { skipSelf: boolean },
        ) => Promise<{ id: string; external?: boolean } | null>;
      },
      source: string,
      importer?: string,
    ) {
      const query = source.indexOf(MOUNT_QUERY);
      const tagged =
        query >= 0 ? decodeURIComponent(source.slice(query + MOUNT_QUERY.length)) : undefined;
      const importerQuery = importer?.indexOf(MOUNT_QUERY) ?? -1;
      const inherited =
        importerQuery >= 0
          ? decodeURIComponent(importer!.slice(importerQuery + MOUNT_QUERY.length))
          : undefined;
      const cleanSource = query >= 0 ? source.slice(0, query) : source;
      const cleanImporter = importerQuery >= 0 ? importer!.slice(0, importerQuery) : importer;
      const importerPath = cleanImporter === undefined ? undefined : canonical(cleanImporter);
      const declarationMount =
        importerPath === undefined ? undefined : declarationPaths.get(importerPath);
      const overrideMount =
        importerPath === undefined ? undefined : overrideMounts.get(importerPath);
      const mountId = tagged ?? inherited ?? declarationMount?.mountId ?? overrideMount?.mountId;
      const mount = mountId === undefined ? undefined : byId.get(mountId);
      if (mountId !== undefined && mount === undefined)
        throw new Error(`Unknown extension mount "${mountId}".`);

      // An override has mount context for its imports, but remains application-owned:
      // its own state and all of its other dependencies keep their ordinary identity.
      const override =
        mount !== undefined &&
        importerPath !== undefined &&
        !within(importerPath, mount.root) &&
        overrideMounts.get(importerPath) === mount;
      const sourceMount =
        mount !== undefined && cleanSource === mount.specifier ? mount : undefined;
      const builtInEntry =
        sourceMount?.packageName === "eve" && cleanImporter !== undefined
          ? ((sourceMount.specifier === "eve/self-modification"
              ? ["extension.ts", "extension.js"]
                  .map((name) => join(sourceMount.root, name))
                  .find((path) => existsSync(path))
              : undefined) ?? createRequire(cleanImporter).resolve(cleanSource))
          : undefined;
      const resolved = await this.resolve(builtInEntry ?? cleanSource, cleanImporter, {
        skipSelf: true,
      });
      if (resolved === null || resolved.id.startsWith("\0")) return resolved;
      if (resolved.external) {
        if (sourceMount === undefined) return resolved;
        throw new Error(
          `Extension export "${cleanSource}" for mount "${mountId}" was externalized; it must be bundled to isolate its configuration.`,
        );
      }
      const path = canonical(resolved.id.split("?")[0]!);
      if (
        mount !== undefined &&
        (sourceMount !== undefined || (!override && within(path, mount.root)))
      ) {
        return { id: `${resolved.id}${MOUNT_QUERY}${encodeURIComponent(mountId!)}` };
      }
      if (mount !== undefined) return resolved;
      if (importer === undefined || importer.startsWith("\0")) return undefined;
      const owners = roots.filter((root) => within(path, root.root));
      if (owners.length > 1) {
        throw new Error(
          `Import "${source}" from "${importer}" refers to multiple extension mounts (${owners.map((owner) => owner.mountId).join(", ")}). Import it from an owned mount or contribution instead.`,
        );
      }
      return owners.length === 1
        ? { id: `${resolved.id}${MOUNT_QUERY}${encodeURIComponent(owners[0]!.mountId)}` }
        : undefined;
    },
    load(id: string) {
      const query = id.indexOf(MOUNT_QUERY);
      if (query < 0) return undefined;
      const path = id.slice(0, query);
      const extension = path.slice(path.lastIndexOf(".") + 1);
      const moduleType =
        extension === "json"
          ? "json"
          : extension === "tsx"
            ? "tsx"
            : extension === "jsx"
              ? "jsx"
              : ["ts", "mts", "cts"].includes(extension)
                ? "ts"
                : "js";
      return { code: readFileSync(path, "utf8"), moduleType };
    },
  };
}
