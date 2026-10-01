import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

import { isEnclosingExtensionMount } from "#compiler/source-graph.js";

const MOUNT_QUERY = "?eve-mount=";

interface Mount {
  readonly mountId: string;
  readonly sourceRoot: string;
  readonly packageName: string;
  readonly specifier?: string;
  readonly mountSourcePath?: string;
  readonly programmaticImport?: { readonly specifier: string; readonly entryPath: string };
}

function canonicalize(path: string): string {
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
  // Every import in the bundle resolves through this plugin, and each JS
  // realpath walks the whole path. One plugin instance serves one build.
  const canonicalPaths = new Map<string, string>();
  const canonical = (path: string): string => {
    let canonicalPath = canonicalPaths.get(path);
    if (canonicalPath === undefined) {
      canonicalPath = canonicalize(path);
      canonicalPaths.set(path, canonicalPath);
    }
    return canonicalPath;
  };
  const roots = mounts.map((mount) => ({ ...mount, root: canonical(mount.sourceRoot) }));
  // A mount file inside an extension subagent declares one mount per enclosing mount.
  const declarationPaths = new Map<string, (typeof roots)[number][]>();
  for (const mount of roots) {
    if (mount.mountSourcePath === undefined) continue;
    const path = canonical(resolve(mount.mountSourcePath));
    declarationPaths.set(path, [...(declarationPaths.get(path) ?? []), mount]);
  }
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
          options?: { skipSelf: boolean; kind?: "import-statement" },
        ) => Promise<{ id: string; external?: boolean } | null>;
      },
      source: string,
      importer?: string,
    ) {
      if (source === "eve/context") return undefined;
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
      const declarations =
        importerPath === undefined ? [] : (declarationPaths.get(importerPath) ?? []);
      const declarationMount =
        declarations.length === 1
          ? declarations[0]
          : declarations.find(
              (candidate) =>
                inherited !== undefined && isEnclosingExtensionMount(inherited, candidate.mountId),
            );
      // A nested mount file is loaded as its enclosing extension's source, but the extension it
      // mounts must bind that mount's own instance.
      const declaredSource =
        declarationMount !== undefined &&
        (cleanSource === declarationMount.specifier ||
          cleanSource === declarationMount.programmaticImport?.specifier)
          ? declarationMount
          : undefined;
      const overrideMount =
        importerPath === undefined ? undefined : overrideMounts.get(importerPath);
      const mountId =
        tagged ??
        declaredSource?.mountId ??
        inherited ??
        declarationMount?.mountId ??
        overrideMount?.mountId;
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
        mount !== undefined &&
        (cleanSource === mount.specifier || cleanSource === mount.programmaticImport?.specifier)
          ? mount
          : undefined;
      // Use ESM conditions for authored exports; programmatic mounts supply their entry.
      const resolved = await this.resolve(
        sourceMount?.programmaticImport?.entryPath ?? cleanSource,
        cleanImporter,
        {
          skipSelf: true,
          kind: "import-statement",
        },
      );
      if (resolved === null || resolved.id.startsWith("\0")) return resolved;
      if (resolved.external) {
        if (sourceMount === undefined) return resolved;
        throw new Error(
          `Extension export "${cleanSource}" for mount "${mountId}" was externalized; it must be bundled to isolate its configuration.`,
        );
      }
      // Assets have no mutable module state. Preserve their loader's query and identity.
      if (!/\.(?:[cm]?[jt]sx?|json)$/.test(resolved.id)) return resolved;
      const path = canonical(resolved.id);
      if (
        mount !== undefined &&
        (sourceMount !== undefined || (!override && within(path, mount.root)))
      ) {
        return { id: `${resolved.id}${MOUNT_QUERY}${encodeURIComponent(mountId!)}` };
      }
      if (override) return resolved;
      if (mount === undefined && (importer === undefined || importer.startsWith("\0"))) {
        return undefined;
      }
      const owners = roots.filter((root) => within(path, root.root));
      if (mount !== undefined) {
        // Source owned by another extension keeps that extension's mount identity, so a mount
        // declared inside an extension reads the configuration its enclosing mount bound. When
        // the extension is mounted more than once, the enclosing mount disambiguates.
        const owner =
          owners
            .filter((candidate) => isEnclosingExtensionMount(candidate.mountId, mount.mountId))
            .sort((left, right) => right.mountId.length - left.mountId.length)[0] ??
          (owners.length === 1 ? owners[0] : undefined);
        return owner === undefined
          ? resolved
          : { id: `${resolved.id}${MOUNT_QUERY}${encodeURIComponent(owner.mountId)}` };
      }
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
      if (!/\.(?:[cm]?[jt]sx?|json)$/.test(path)) return undefined;
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
