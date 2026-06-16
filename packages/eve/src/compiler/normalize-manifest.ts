import type { AgentSourceManifest } from "#discover/manifest.js";
import {
  type CompiledAgentManifest,
  type CompiledAgentNodeManifest,
  type CompiledDynamicInstructionsDefinition,
  type CompiledDynamicSkillDefinition,
  type CompiledDynamicToolDefinition,
  type CompiledInstructions,
  type CompiledSkillDefinition,
  type CompiledToolDefinition,
  createCompiledAgentManifest,
  createCompiledAgentNodeManifest,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "#compiler/manifest.js";
import { createCompiledRuntimeModelCatalogLoader } from "#compiler/model-catalog.js";
import { compileAgentConfig } from "#compiler/normalize-agent-config.js";
import { compileChannelDefinition } from "#compiler/normalize-channel.js";
import { compileConnectionDefinition } from "#compiler/normalize-connection.js";
import type { ManifestCompileContext } from "#compiler/normalize-helpers.js";
import { compileHookEntry } from "#compiler/normalize-hook.js";
import { compileSandboxDefinition } from "#compiler/normalize-sandbox.js";
import { compileInstructionsEntry } from "#compiler/normalize-instructions.js";
import { compileScheduleDefinition } from "#compiler/normalize-schedule.js";
import { compileSkillSource } from "#compiler/normalize-skill.js";
import { compileSubagentGraph } from "#compiler/normalize-subagent.js";
import { compileToolEntry } from "#compiler/normalize-tool.js";

/**
 * Compiles one discovery manifest into the normalized manifest loaded by the runtime.
 */
export async function compileAgentManifest(
  manifest: AgentSourceManifest,
): Promise<CompiledAgentManifest> {
  const context: ManifestCompileContext = {
    modelCatalog: createCompiledRuntimeModelCatalogLoader(manifest.appRoot),
  };
  const compiledNode = await compileAgentNodeManifest(manifest, context);
  const subagentGraph = await compileSubagentGraph({
    appRoot: manifest.appRoot,
    compileAgentNodeManifest,
    context,
    externalDependencies: compiledNode.config.build?.externalDependencies ?? [],
    parentNodeId: ROOT_COMPILED_AGENT_NODE_ID,
    subagents: manifest.subagents,
  });

  return createCompiledAgentManifest({
    ...compiledNode,
    remoteAgents: subagentGraph.remoteAgents,
    subagentEdges: subagentGraph.edges,
    subagents: subagentGraph.nodes,
  });
}

async function compileAgentNodeManifest(
  manifest: AgentSourceManifest,
  context: ManifestCompileContext,
  options: { readonly externalDependencies?: readonly string[] } = {},
): Promise<CompiledAgentNodeManifest> {
  const rawConfig = await compileAgentConfig(manifest, context);
  const externalDependencies = mergeExternalDependencies(
    options.externalDependencies,
    rawConfig.build?.externalDependencies,
  );
  const config =
    externalDependencies.length === 0
      ? rawConfig
      : {
          ...rawConfig,
          build: {
            ...rawConfig.build,
            externalDependencies,
          },
        };
  const compiledToolEntries = await Promise.all(
    manifest.tools.map((toolSource) =>
      compileToolEntry(manifest.agentRoot, toolSource, { externalDependencies }),
    ),
  );
  const tools: CompiledToolDefinition[] = [];
  const dynamicTools: CompiledDynamicToolDefinition[] = [];
  const disabledFrameworkTools: string[] = [];
  let workflowEnabled = false;

  for (const entry of compiledToolEntries) {
    if (entry.kind === "tool") {
      tools.push(entry.definition);
    } else if (entry.kind === "dynamic-tool") {
      dynamicTools.push(entry.definition);
    } else if (entry.kind === "enable-workflow") {
      workflowEnabled = true;
    } else {
      disabledFrameworkTools.push(entry.name);
    }
  }

  const compiledChannelResults = await Promise.all(
    manifest.channels.map((channelSource) =>
      compileChannelDefinition(manifest.agentRoot, channelSource, { externalDependencies }),
    ),
  );

  // compileChannelDefinition returns one entry for a disabled-channel
  // sentinel or an array of entries (one per route) for an authored
  // CompiledChannel. Flatten so the manifest holds a single channel list.
  const compiledChannels = compiledChannelResults.flat();

  const compiledSkillEntries = await Promise.all(
    manifest.skills.map((skillSource) =>
      compileSkillSource(manifest.agentRoot, skillSource, { externalDependencies }),
    ),
  );
  const skills: CompiledSkillDefinition[] = [];
  const dynamicSkills: CompiledDynamicSkillDefinition[] = [];

  for (const entry of compiledSkillEntries) {
    if (entry.kind === "skill") {
      skills.push(entry.definition);
    } else {
      dynamicSkills.push(entry.definition);
    }
  }

  const compiledInstructionsEntries = await Promise.all(
    manifest.instructions.map((source) =>
      compileInstructionsEntry(manifest.agentRoot, source, { externalDependencies }),
    ),
  );
  const staticInstructions: CompiledInstructions[] = [];
  const dynamicInstructions: CompiledDynamicInstructionsDefinition[] = [];

  for (const entry of compiledInstructionsEntries) {
    if (entry.kind === "instructions") {
      staticInstructions.push(entry.definition);
    } else {
      dynamicInstructions.push(entry.definition);
    }
  }

  const composedInstructions: CompiledInstructions | undefined =
    staticInstructions.length === 0
      ? undefined
      : staticInstructions.length === 1
        ? staticInstructions[0]
        : {
            name: "instructions",
            logicalPath: "instructions",
            markdown: staticInstructions.map((i) => i.markdown).join("\n\n"),
            sourceId: staticInstructions[0]!.sourceId,
            sourceKind: "module",
          };

  return createCompiledAgentNodeManifest({
    agentRoot: manifest.agentRoot,
    appRoot: manifest.appRoot,
    channels: compiledChannels,
    config,
    connections: await Promise.all(
      manifest.connections.map((connectionSource) =>
        compileConnectionDefinition(manifest.agentRoot, connectionSource, { externalDependencies }),
      ),
    ),
    diagnosticsSummary: manifest.diagnosticsSummary,
    disabledFrameworkTools,
    workflowEnabled,
    dynamicSkills,
    dynamicTools,
    hooks: manifest.hooks.map((hookSource) => compileHookEntry(hookSource)),
    sandbox:
      manifest.sandbox === null
        ? null
        : await compileSandboxDefinition(manifest.agentRoot, manifest.sandbox, {
            externalDependencies,
          }),
    sandboxWorkspaces: manifest.sandboxWorkspaces.map((workspace) => ({
      logicalPath: workspace.logicalPath,
      rootEntries: [...workspace.rootEntries],
      sourceId: workspace.sourceId,
      sourcePath: workspace.sourcePath,
    })),
    schedules: await Promise.all(
      manifest.schedules.map((scheduleSource) =>
        compileScheduleDefinition(manifest.agentRoot, scheduleSource, { externalDependencies }),
      ),
    ),
    dynamicInstructions,
    skills,
    instructions: composedInstructions,
    tools,
  });
}

function mergeExternalDependencies(
  ...dependencyLists: ReadonlyArray<readonly string[] | undefined>
): string[] {
  const dependencies = new Set<string>();

  for (const dependencyList of dependencyLists) {
    for (const dependencyName of dependencyList ?? []) {
      dependencies.add(dependencyName);
    }
  }

  return [...dependencies];
}
