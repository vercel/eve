import {
  defineProgrammaticExtensionMountDeclaration,
  type ProgrammaticAgentSource,
} from "#compiler/source-graph.js";
import { resolveInstalledPackageInfo, resolvePackageRoot } from "#internal/application/package.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";

export interface BundledExtensionDescriptor {
  readonly entryPath: string;
  readonly importSpecifier: string;
  readonly config: JsonObject;
  readonly namespace: string;
  readonly sourceDirectory: string;
}

export interface BundledExtensionMount {
  readonly declaration: ProgrammaticAgentSource;
  readonly entryPath: string;
  readonly importSpecifier: string;
  readonly config: JsonObject;
  readonly namespace: string;
  readonly packageName: string;
  readonly packageRoot: string;
  readonly sourceRoot: string;
  readonly specifier: string;
}

export function createBundledExtensionMount(
  descriptor: BundledExtensionDescriptor,
): BundledExtensionMount {
  const packageInfo = resolveInstalledPackageInfo();
  const packageName = packageInfo.name;
  const packageRoot = resolvePackageRoot();
  const revision = `eve@${packageInfo.version}:development-extensions-v1`;
  const logicalPath = `extensions/${descriptor.namespace}.ts`;
  const config = parseJsonObject(descriptor.config);
  const declaration = defineProgrammaticExtensionMountDeclaration({
    id: `eve:development-extension:${descriptor.namespace}`,
    revision,
    modules: [
      {
        logicalPath,
        loadNamespace: async () => {
          const { default: extension } = await import(descriptor.importSpecifier);
          return { default: extension(config) };
        },
      },
    ],
  });

  return Object.freeze({
    declaration,
    entryPath: descriptor.entryPath,
    importSpecifier: descriptor.importSpecifier,
    config,
    namespace: descriptor.namespace,
    packageName,
    packageRoot,
    sourceRoot: descriptor.sourceDirectory,
    specifier: `${packageName}/${descriptor.namespace}`,
  });
}
