import { packageStateNamespace } from "#discover/extensions.js";
import {
  defineProgrammaticExtensionMountDeclaration,
  type ProgrammaticAgentSource,
} from "#compiler/source-graph.js";
import { resolveInstalledPackageInfo, resolvePackageRoot } from "#internal/application/package.js";

/** The small descriptor used for extensions shipped inside eve. */
export interface BundledExtensionDescriptor {
  readonly loadMount: () => Promise<unknown>;
  readonly namespace: string;
  readonly sourceDirectory: string;
}

export interface BundledExtensionMount {
  readonly declaration: ProgrammaticAgentSource;
  readonly namespace: string;
  readonly packageName: string;
  readonly packageRoot: string;
  readonly sourceRoot: string;
  readonly specifier: string;
}

/** Adapts one bundled descriptor to the virtual extension mount consumed by discovery. */
export function createBundledExtensionMount(
  descriptor: BundledExtensionDescriptor,
): BundledExtensionMount {
  const packageInfo = resolveInstalledPackageInfo();
  const packageName = packageInfo.name;
  const packageRoot = resolvePackageRoot();
  const revision = `eve@${packageInfo.version}:development-extensions-v1`;
  const logicalPath = `extensions/${descriptor.namespace}.ts`;
  const declaration = defineProgrammaticExtensionMountDeclaration({
    id: `eve:development-extension:${descriptor.namespace}`,
    revision,
    modules: [
      {
        logicalPath,
        loadNamespace: async () => {
          const container = globalThis as Record<symbol, unknown>;
          const scopeSymbol = Symbol.for("eve.ext-config-scope");
          const previousScope = container[scopeSymbol];
          container[scopeSymbol] = packageStateNamespace(packageName);
          try {
            return { default: await descriptor.loadMount() };
          } finally {
            if (previousScope === undefined) delete container[scopeSymbol];
            else container[scopeSymbol] = previousScope;
          }
        },
      },
    ],
  });

  return Object.freeze({
    declaration,
    namespace: descriptor.namespace,
    packageName,
    packageRoot,
    sourceRoot: descriptor.sourceDirectory,
    specifier: `${packageName}/${descriptor.namespace}`,
  });
}
