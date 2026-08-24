import { basename, isAbsolute, relative, resolve } from "node:path";

import {
  type CompilerArtifactLocations,
  writePrecompiledCompilerArtifacts,
} from "#compiler/artifacts.js";
import type { CompileAgentResult } from "#compiler/compile-agent.js";
import { compiledAgentManifestSchema } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { createAgentSourceManifest, createModuleSourceRef } from "#discover/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { loadEmbeddedAgentEntrypoint } from "./definition.js";

const EMBEDDED_INSTRUCTIONS_LOGICAL_PATH = "instructions.md";

export interface CompileEmbeddedAgentResult extends CompileAgentResult {
  readonly moduleMap: CompiledModuleMap;
}

export async function compileEmbeddedAgent(input: {
  readonly appRoot: string;
  readonly artifactLocations?: CompilerArtifactLocations;
  readonly entrypoint: string;
}): Promise<CompileEmbeddedAgentResult> {
  const loaded = await loadEmbeddedAgentEntrypoint({
    appRoot: input.appRoot,
    entrypoint: input.entrypoint,
  });
  const appRoot = loaded.appRoot;
  const entrypointLogicalPath = relative(appRoot, loaded.entrypointPath).replaceAll("\\", "/");
  if (
    entrypointLogicalPath === "" ||
    entrypointLogicalPath.startsWith("..") ||
    isAbsolute(entrypointLogicalPath)
  ) {
    throw new Error(`Expected embedded entrypoint "${input.entrypoint}" to be under "${appRoot}".`);
  }

  const configModule = createModuleSourceRef({
    logicalPath: entrypointLogicalPath,
    sourceId: `embedded:config:${entrypointLogicalPath}`,
  });
  const discoveryManifest = createAgentSourceManifest({
    agentId: basename(appRoot),
    agentRoot: appRoot,
    appRoot,
    configModule,
    instructions: [
      {
        definition: { content: loaded.instructions, role: "system" },
        logicalPath: EMBEDDED_INSTRUCTIONS_LOGICAL_PATH,
        sourceId: `embedded:instructions:${EMBEDDED_INSTRUCTIONS_LOGICAL_PATH}`,
        sourceKind: "markdown",
      },
    ],
  });
  const compiledManifest = compiledAgentManifestSchema.parse(
    await compileAgentManifest(discoveryManifest, {
      agentConfigDefinition: loaded.definition,
    }),
  );
  const artifactLocations = input.artifactLocations ?? {
    publishedRoot: resolve(appRoot, ".eve"),
    writeRoot: resolve(appRoot, ".eve"),
  };
  const written = await writePrecompiledCompilerArtifacts({
    appRoot,
    artifactLocations,
    compiledManifest,
    diagnostics: [],
    discoveryManifest,
  });

  return {
    diagnostics: [],
    manifest: written.compiledManifest,
    metadata: written.metadata,
    moduleMap: {
      nodes: {
        [ROOT_COMPILED_AGENT_NODE_ID]: {
          modules: {
            [configModule.sourceId]: loaded.moduleNamespace,
          },
        },
      },
    },
    paths: written.paths,
    project: {
      agentRoot: appRoot,
      appRoot,
      layout: "flat",
    },
  };
}
