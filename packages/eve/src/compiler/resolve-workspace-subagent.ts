import { relative } from "node:path";

import { discoverAgent } from "#discover/discover-agent.js";
import type { LocalSubagentSourceRef } from "#discover/manifest.js";
import { findEveProjectContext } from "#internal/project-context.js";
import { normalizeAgentDefinition } from "#internal/authored-definition/core.js";
import { createCompiledBindingNamespaceLoader } from "#compiler/load-binding-namespace.js";
import { loadModuleBackedDefinition } from "#compiler/normalize-helpers.js";
import type { NormalizedSubagentConfig } from "#compiler/normalize-subagent.js";
import type { AgentSourceRegistry } from "#compiler/source-graph.js";

export async function resolveWorkspaceSubagentDefinition(input: {
  readonly definition: Extract<NormalizedSubagentConfig, { readonly kind: "remote" }>;
  readonly path: string;
  readonly registries: readonly AgentSourceRegistry[];
  readonly source: LocalSubagentSourceRef;
}): Promise<Extract<NormalizedSubagentConfig, { readonly kind: "remote" }>> {
  if (input.definition.description.trim().length > 0) return input.definition;
  const workspaceContext = await findEveProjectContext(input.source.rootPath);
  if (workspaceContext?.kind !== "workspace-member") {
    throw new Error(
      `Workspace subagent "${input.source.logicalPath}" must be authored by an agent workspace member.`,
    );
  }
  const member = workspaceContext.workspace.members.find(
    (candidate) => relative(workspaceContext.workspace.root, candidate.appRoot) === input.path,
  );
  if (member === undefined) {
    throw new Error(
      `Workspace subagent "${input.source.logicalPath}" targets unknown workspace member ${JSON.stringify(input.path)}.`,
    );
  }
  const { resolveDiscoveryProject } = await import("#discover/project.js");
  const project = await resolveDiscoveryProject(member.appRoot);
  const peer = await discoverAgent({ agentRoot: project.agentRoot, appRoot: project.appRoot });
  const configSource = peer.manifest.configModule;
  if (configSource === undefined) {
    throw new Error(`Workspace member ${JSON.stringify(input.path)} has no agent config module.`);
  }
  const binding = {
    backing: {
      externalDependencies: [],
      kind: "filesystem" as const,
      sourcePath: `${project.agentRoot}/${configSource.logicalPath}`,
    },
    logicalPath: configSource.logicalPath,
    owner: { kind: "application" as const },
  };
  const definition = normalizeAgentDefinition(
    await loadModuleBackedDefinition({
      binding,
      kind: "agent config",
      loadNamespace: createCompiledBindingNamespaceLoader({
        bindings: { [configSource.sourceId]: binding },
        registries: input.registries,
      }),
      source: configSource,
    }),
    `Expected workspace member ${JSON.stringify(input.path)} agent config to match the public eve shape.`,
  );
  if (definition.description === undefined || definition.description.trim().length === 0) {
    throw new Error(
      `Workspace member ${JSON.stringify(input.path)} must define a non-empty description.`,
    );
  }
  return { ...input.definition, description: definition.description };
}
