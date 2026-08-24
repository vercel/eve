import { join } from "node:path";

import {
  EXTENSION_CAPABILITY_VERSIONS,
  type ExtensionCapability,
  type ExtensionCapabilityRequirements,
} from "#compiler/extension-compatibility.js";
import { compileInstructionsEntry } from "#compiler/normalize-instructions.js";
import { compileSkillSource } from "#compiler/normalize-skill.js";
import { compileToolEntry } from "#compiler/normalize-tool.js";
import type { AgentSourceManifest } from "#discover/manifest.js";
import { loadAuthoredModuleNamespace } from "#internal/authored-module-loader.js";
import { extensionUsesState } from "#internal/nitro/host/extension-state-usage.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { SourceDefinitionCompileOptions } from "#compiler/normalize-helpers.js";

/** Derives only the extension-facing contracts used by one authored tree. */
export async function deriveExtensionCapabilityRequirements(input: {
  readonly declarationModule: ModuleSourceRef;
  readonly manifest: AgentSourceManifest;
  readonly packageName: string;
  readonly runtimeDependencies: readonly string[];
  readonly shortName: string;
  readonly sourceRoot: string;
}): Promise<ExtensionCapabilityRequirements> {
  const required = new Set<ExtensionCapability>(["extension"]);
  const manifests = collectSubagentManifests(input.manifest);
  const [tools, skills, instructions, declaration, usesState] = await Promise.all([
    Promise.all(
      manifests.flatMap((manifest) =>
        manifest.tools.map((source) =>
          compileToolEntry(
            manifest.agentRoot,
            source,
            createLoadOptions(input, source, manifest.agentRoot),
          ),
        ),
      ),
    ),
    Promise.all(
      manifests.flatMap((manifest) =>
        manifest.skills.map((source) =>
          compileSkillSource(
            manifest.agentRoot,
            source,
            createLoadOptions(input, source, manifest.agentRoot),
          ),
        ),
      ),
    ),
    Promise.all(
      manifests.flatMap((manifest) =>
        manifest.instructions.map((source) =>
          compileInstructionsEntry(
            manifest.agentRoot,
            source,
            createLoadOptions(input, source, manifest.agentRoot),
          ),
        ),
      ),
    ),
    loadAuthoredModuleNamespace(join(input.sourceRoot, input.declarationModule.logicalPath), {
      externalDependencies: input.runtimeDependencies,
    }),
    extensionUsesState(input.sourceRoot),
  ]);

  if (tools.length > 0) required.add("tool");
  if (tools.some((entry) => entry.kind === "dynamic-tool")) required.add("dynamicTool");
  if (manifests.some((manifest) => manifest.channels.length > 0)) required.add("channel");
  if (manifests.some((manifest) => manifest.connections.length > 0)) required.add("connection");
  if (manifests.some((manifest) => manifest.hooks.length > 0)) required.add("hook");
  if (manifests.some((manifest) => manifest.schedules.length > 0)) required.add("schedule");
  if (manifests.some((manifest) => manifest.subagents.length > 0)) required.add("subagent");
  if (skills.length > 0) required.add("skill");
  if (skills.some((entry) => entry.kind === "dynamic-skill")) required.add("dynamicSkill");
  if (instructions.length > 0) required.add("instructions");
  if (instructions.some((entry) => entry.kind === "dynamic-instructions")) {
    required.add("dynamicInstructions");
  }
  const declarationExport = declaration[input.declarationModule.exportName ?? "default"];
  if (
    (typeof declarationExport === "function" ||
      (typeof declarationExport === "object" && declarationExport !== null)) &&
    "schema" in declarationExport &&
    declarationExport.schema !== undefined
  ) {
    required.add("config");
  }
  if (usesState) required.add("state");

  return Object.fromEntries(
    (Object.keys(EXTENSION_CAPABILITY_VERSIONS) as ExtensionCapability[])
      .filter((capability) => required.has(capability))
      .map((capability) => [capability, EXTENSION_CAPABILITY_VERSIONS[capability]]),
  );
}

function createLoadOptions(
  input: {
    readonly packageName: string;
    readonly runtimeDependencies: readonly string[];
    readonly shortName: string;
    readonly sourceRoot: string;
  },
  source: { readonly logicalPath: string },
  moduleRoot: string,
): SourceDefinitionCompileOptions & {
  readonly binding: NonNullable<SourceDefinitionCompileOptions["binding"]>;
  readonly registries: readonly [];
} {
  const owner = {
    kind: "extension" as const,
    namespace: input.shortName,
    packageName: input.packageName,
  };
  return {
    binding: {
      backing: {
        externalDependencies: input.runtimeDependencies,
        extensionScope: { namespace: input.shortName, sourceRoot: input.sourceRoot },
        kind: "filesystem",
        sourcePath: join(moduleRoot, source.logicalPath),
      },
      logicalPath: source.logicalPath,
      owner,
    },
    owner,
    registries: [],
  };
}

function collectSubagentManifests(manifest: AgentSourceManifest): AgentSourceManifest[] {
  return [
    manifest,
    ...manifest.subagents.flatMap((subagent) => collectSubagentManifests(subagent.manifest)),
  ];
}
