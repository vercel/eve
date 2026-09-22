import { discoverAgent } from "#discover/discover-agent.js";
import { createDiskProjectSource, type ProjectSource } from "#discover/project-source.js";
import type { DiscoverDiagnostic } from "#discover/diagnostics.js";
import type { ResolvedExtensionMount } from "#discover/manifest.js";
import type { BundledExtensionMount } from "#compiler/bundled-extension.js";

export async function discoverBundledExtension(input: {
  readonly mount: BundledExtensionMount;
  readonly source?: ProjectSource;
}): Promise<{
  readonly diagnostics: readonly DiscoverDiagnostic[];
  readonly mount: ResolvedExtensionMount;
}> {
  const source = input.source ?? createDiskProjectSource();
  const result = await discoverAgent({
    agentRoot: input.mount.sourceRoot,
    appRoot: input.mount.packageRoot,
    role: "extension",
    source,
  });
  const declaration = input.mount.declaration.modules[0];
  if (declaration === undefined) {
    throw new Error(`Bundled extension "${input.mount.namespace}" has no declaration module.`);
  }

  return {
    diagnostics: result.diagnostics,
    mount: {
      externalDependencies: [],
      manifest: result.manifest,
      namespace: input.mount.namespace,
      packageName: input.mount.packageName,
      packageRoot: input.mount.packageRoot,
      programmaticDeclaration: {
        logicalPath: declaration.logicalPath,
        sourceId: `${input.mount.declaration.id}:${declaration.logicalPath}`,
      },
      sourceRoot: input.mount.sourceRoot,
      specifier: input.mount.specifier,
    },
  };
}
