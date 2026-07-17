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

/** Derives only the extension-facing contracts used by one authored tree. */
export async function deriveExtensionCapabilityRequirements(input: {
  readonly declarationModule: ModuleSourceRef;
  readonly manifest: AgentSourceManifest;
  readonly runtimeDependencies: readonly string[];
  readonly sourceRoot: string;
}): Promise<ExtensionCapabilityRequirements> {
  const required = new Set<ExtensionCapability>(["extension"]);
  const loadOptions = { externalDependencies: input.runtimeDependencies };
  const [tools, skills, instructions, declaration, usesState] = await Promise.all([
    Promise.all(
      input.manifest.tools.map((source) => compileToolEntry(input.sourceRoot, source, loadOptions)),
    ),
    Promise.all(
      input.manifest.skills.map((source) =>
        compileSkillSource(input.sourceRoot, source, loadOptions),
      ),
    ),
    Promise.all(
      input.manifest.instructions.map((source) =>
        compileInstructionsEntry(input.sourceRoot, source, loadOptions),
      ),
    ),
    loadAuthoredModuleNamespace(join(input.sourceRoot, input.declarationModule.logicalPath), {
      externalDependencies: input.runtimeDependencies,
    }),
    extensionUsesState(input.sourceRoot),
  ]);

  if (tools.length > 0) required.add("tool");
  if (tools.some((entry) => entry.kind === "dynamic-tool")) required.add("dynamicTool");
  if (input.manifest.connections.length > 0) required.add("connection");
  if (input.manifest.hooks.length > 0) required.add("hook");
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
