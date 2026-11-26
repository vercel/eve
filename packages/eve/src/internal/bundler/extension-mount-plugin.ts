import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import type { Plugin } from "rolldown";

import { escapeRegex, prefixRegex } from "#internal/bundler/filters.js";

const MOUNT_QUERY = "?eve-mount=";
const MOUNT_BIND_PREFIX = "\0eve-mount-bind:";
const EXTENSION_DECLARATION_BASENAME = /^extension\.[cm]?[jt]sx?$/;

export const EXTENSION_CHUNK_DIRECTORY = "_chunks";

export interface WorkflowExtensionMount {
  readonly mountId: string;
  readonly sourceRoot: string;
}

interface Mount extends WorkflowExtensionMount {
  readonly packageName: string;
  readonly specifier?: string;
  readonly mountSourcePath?: string;
  readonly programmaticImport?: {
    readonly specifier: string;
    readonly entryPath: string;
    readonly config?: unknown;
  };
}

export function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

export function isExtensionModule(path: string, root: string): boolean {
  return within(path, root) || within(path, join(dirname(root), EXTENSION_CHUNK_DIRECTORY));
}

export function parseExtensionMountId(id: string): {
  readonly filePath: string;
  readonly mountId: string | undefined;
} {
  const query = id.indexOf(MOUNT_QUERY);
  if (query < 0) return { filePath: id, mountId: undefined };
  const tail = id.slice(query + MOUNT_QUERY.length);
  const end = tail.search(/[&#]/);
  return {
    filePath: id.slice(0, query),
    mountId: decodeURIComponent(end < 0 ? tail : tail.slice(0, end)),
  };
}

export function tagExtensionMountId(filePath: string, mountId: string): string {
  return `${filePath}${MOUNT_QUERY}${encodeURIComponent(mountId)}`;
}

export function resolveExtensionMountForId(
  id: string,
  mounts: readonly WorkflowExtensionMount[] | undefined,
  fixedMount?: WorkflowExtensionMount,
): WorkflowExtensionMount | undefined {
  const { filePath, mountId } = parseExtensionMountId(id);
  const mount =
    mountId !== undefined ? mounts?.find((candidate) => candidate.mountId === mountId) : fixedMount;
  return mount !== undefined &&
    isExtensionModule(canonicalizePath(filePath), canonicalizePath(mount.sourceRoot))
    ? mount
    : undefined;
}

export function extensionModuleType(path: string): "json" | "tsx" | "jsx" | "ts" | "js" {
  const extension = path.slice(path.lastIndexOf(".") + 1);
  if (extension === "json") return "json";
  if (extension === "tsx") return "tsx";
  if (extension === "jsx") return "jsx";
  if (extension === "ts" || extension === "mts" || extension === "cts") return "ts";
  return "js";
}

function isExtensionDeclarationFile(canonicalFilePath: string, canonicalRoot: string): boolean {
  return (
    dirname(canonicalFilePath) === canonicalRoot &&
    EXTENSION_DECLARATION_BASENAME.test(basename(canonicalFilePath))
  );
}

export function createExtensionMountPlugin(
  mounts: readonly Mount[],
  overridePaths: ReadonlyMap<string, string> = new Map(),
  options: { readonly bindHandles?: boolean } = {},
): Plugin | null {
  if (mounts.length === 0) return null;
  const bindHandles = options.bindHandles === true;
  const canonicalPaths = new Map<string, string>();
  const canonical = (path: string): string => {
    let canonicalPath = canonicalPaths.get(path);
    if (canonicalPath === undefined) {
      canonicalPath = canonicalizePath(path);
      canonicalPaths.set(path, canonicalPath);
    }
    return canonicalPath;
  };
  const roots = mounts.map((mount) => ({ ...mount, root: canonical(mount.sourceRoot) }));
  const declarationPaths = new Map<string, (typeof roots)[number][]>();
  for (const mount of roots) {
    if (mount.mountSourcePath === undefined || mount.programmaticImport !== undefined) continue;
    const path = canonical(resolve(mount.mountSourcePath));
    declarationPaths.set(path, [...(declarationPaths.get(path) ?? []), mount]);
  }
  const byId = new Map(roots.map((mount) => [mount.mountId, mount]));
  const overrideMounts = new Map(
    [...overridePaths].map(([path, id]) => [canonical(path), byId.get(id)]),
  );
  const packageEntryPaths = new Set<string>();
  const loadFilter = bindHandles
    ? [new RegExp(escapeRegex(MOUNT_QUERY)), prefixRegex(MOUNT_BIND_PREFIX)]
    : new RegExp(escapeRegex(MOUNT_QUERY));
  return {
    name: "eve-extension-mount",
    async resolveId(source, importer) {
      if (source === "eve/context" || source.startsWith(MOUNT_BIND_PREFIX)) return undefined;
      const fromMountBind = importer?.startsWith(MOUNT_BIND_PREFIX) === true;
      const { filePath: cleanSource, mountId: tagged } = parseExtensionMountId(source);
      const parsedImporter = importer === undefined ? undefined : parseExtensionMountId(importer);
      const inherited = parsedImporter?.mountId;
      const cleanImporter = parsedImporter?.filePath;
      const importerPath =
        cleanImporter === undefined || cleanImporter.startsWith("\0")
          ? undefined
          : canonical(cleanImporter);
      const declarations =
        importerPath === undefined ? [] : (declarationPaths.get(importerPath) ?? []);
      const declarationMount =
        declarations.length === 1
          ? declarations[0]
          : declarations.find(
              (candidate) =>
                inherited !== undefined && candidate.mountId.startsWith(`${inherited}/`),
            );
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

      const override =
        mount !== undefined &&
        importerPath !== undefined &&
        !isExtensionModule(importerPath, mount.root) &&
        overrideMounts.get(importerPath) === mount;
      const sourceMount =
        mount !== undefined &&
        (cleanSource === mount.specifier || cleanSource === mount.programmaticImport?.specifier)
          ? mount
          : undefined;
      const resolved = await this.resolve(
        sourceMount?.programmaticImport?.entryPath ?? cleanSource,
        fromMountBind ? undefined : cleanImporter,
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
      if (!/\.(?:[cm]?[jt]sx?|json)$/.test(resolved.id)) return resolved;
      const path = canonical(resolved.id);
      const isBindBypassImporter =
        fromMountBind ||
        declarations.length > 0 ||
        (inherited !== undefined &&
          importerPath !== undefined &&
          packageEntryPaths.has(importerPath));
      const tagTarget = (
        targetMount: (typeof roots)[number],
        isSourceSpecifier: boolean,
        preserveSideEffects: boolean,
      ) => {
        if (isSourceSpecifier) packageEntryPaths.add(path);
        if (
          bindHandles &&
          !isBindBypassImporter &&
          (isSourceSpecifier || isExtensionDeclarationFile(path, targetMount.root))
        ) {
          return {
            id: `${MOUNT_BIND_PREFIX}${encodeURIComponent(targetMount.mountId)}:${resolved.id}`,
          };
        }
        const taggedId = tagExtensionMountId(resolved.id, targetMount.mountId);
        return preserveSideEffects
          ? { id: taggedId, moduleSideEffects: "no-treeshake" as const }
          : { id: taggedId };
      };
      if (
        mount !== undefined &&
        (sourceMount !== undefined ||
          (fromMountBind && packageEntryPaths.has(path)) ||
          (!override && isExtensionModule(path, mount.root)))
      ) {
        return tagTarget(mount, sourceMount !== undefined, false);
      }
      if (override) return resolved;
      if (mount === undefined && (importer === undefined || importer.startsWith("\0"))) {
        return undefined;
      }
      const isMountDeclaration = declarationPaths.has(path);
      const owners = roots.filter((root) => isExtensionModule(path, root.root));
      if (mount !== undefined) {
        const owner =
          owners
            .filter((candidate) => mount.mountId.startsWith(`${candidate.mountId}/`))
            .sort((left, right) => right.mountId.length - left.mountId.length)[0] ??
          (owners.length === 1 ? owners[0] : undefined);
        if (owner !== undefined)
          return tagTarget(owner, false, fromMountBind || isMountDeclaration);
        return fromMountBind || isMountDeclaration
          ? { id: resolved.id, moduleSideEffects: "no-treeshake" as const }
          : resolved;
      }
      const applicationOwners = owners.filter(
        (owner) => !roots.some((other) => owner.mountId.startsWith(`${other.mountId}/`)),
      );
      const candidates = applicationOwners.length > 0 ? applicationOwners : owners;
      if (candidates.length > 1) {
        throw new Error(
          `Import "${source}" from "${importer}" refers to multiple extension mounts (${candidates.map((owner) => owner.mountId).join(", ")}). Import it from an owned mount or contribution instead.`,
        );
      }
      return candidates.length === 1 ? tagTarget(candidates[0]!, false, false) : undefined;
    },
    load: {
      filter: { id: loadFilter },
      handler(id: string) {
        if (bindHandles && id.startsWith(MOUNT_BIND_PREFIX)) {
          const rest = id.slice(MOUNT_BIND_PREFIX.length);
          const separator = rest.indexOf(":");
          if (separator < 0) return undefined;
          const mountId = decodeURIComponent(rest.slice(0, separator));
          const targetFile = rest.slice(separator + 1);
          const mount = byId.get(mountId);
          if (mount === undefined) return undefined;
          const chain = roots
            .filter(
              (candidate) =>
                candidate.mountId === mount.mountId ||
                mount.mountId.startsWith(`${candidate.mountId}/`),
            )
            .sort((left, right) => left.mountId.length - right.mountId.length);
          const lines: string[] = [];
          for (const [index, entry] of chain.entries()) {
            if (entry.programmaticImport !== undefined) {
              lines.push(
                `import * as __eveMount_${index} from ${JSON.stringify(tagExtensionMountId(entry.programmaticImport.specifier, entry.mountId))};`,
                `__eveMount_${index}.default(${JSON.stringify(entry.programmaticImport.config)});`,
              );
            } else if (entry.mountSourcePath !== undefined) {
              lines.push(
                `import ${JSON.stringify(tagExtensionMountId(entry.mountSourcePath, entry.mountId))};`,
              );
            }
          }
          const targetSpecifier = JSON.stringify(tagExtensionMountId(targetFile, mountId));
          lines.push(
            `export * from ${targetSpecifier};`,
            `export { default } from ${targetSpecifier};`,
          );
          return {
            code: `${lines.join("\n")}\n`,
            moduleSideEffects: "no-treeshake" as const,
            moduleType: "js" as const,
          };
        }
        const { filePath, mountId } = parseExtensionMountId(id);
        if (mountId === undefined || !/\.(?:[cm]?[jt]sx?|json)$/.test(filePath)) return undefined;
        return { code: readFileSync(filePath, "utf8"), moduleType: extensionModuleType(filePath) };
      },
    },
  };
}
