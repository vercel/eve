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
        loadNamespace: async () => ({ default: await descriptor.loadMount() }),
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
