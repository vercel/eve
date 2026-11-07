import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { eve } from "#definitions/defaults.js";
import { discoverAgent } from "#discover/discover-agent.js";
import {
  type AgentSourceKind,
  type AgentSourceManifest,
  type InstructionsSourceRef,
  sourcesOf,
} from "#discover/manifest.js";
import { type DynamicContext, dynamicEvaluate, isDynamicSentinel } from "#dynamic/definition.js";
import {
  type AgentDefinition,
  type DefinedAgent,
  defineAgent,
  isDefinedAgent,
} from "#public/definitions/agent.js";
import type { SkillDefinition } from "#public/definitions/skill.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import type { ToolDefinition } from "#tools/definition.js";
import { isWorkflowToolDefinition } from "#tools/workflow-definition.js";

// oxlint-disable-next-line typescript/no-explicit-any -- any tool, whatever its input and output.
type AnyTool = ToolDefinition<any, any>;

// An `agent/` directory as an agent defined in code: what `defineAgent({ ... })` would declare,
// read from its files. Discovery is the compiler's (`discoverAgent`), so the same files count;
// nothing is bundled, and each module is imported, natively, the first time a session asks for
// what it holds. Internal, and Node only.

/**
 * What a directory may hold that only a build can serve yet, and why. `loadAgent` refuses each
 * rather than run part of the agent.
 */
const NEEDS_A_BUILD: Partial<Record<AgentSourceKind, string>> = {
  channel: "channels are routes a deployment serves",
  hook: "hooks have no defineAgent field yet",
  memory: "memory has no defineAgent field yet",
  sandbox: "its sandbox template is prepared at build time",
  schedule: "schedules are crons a deployment registers",
};

/** The agent the directory at `agentRoot` declares, with its subagents. */
export async function loadAgent(
  agentRoot: string,
  options: { readonly appRoot?: string } = {},
): Promise<DefinedAgent> {
  const appRoot = options.appRoot ?? dirname(agentRoot);
  const { diagnostics, manifest } = await discoverAgent({ agentRoot, appRoot });
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    throw new Error(
      `The agent at ${agentRoot} has errors: ${errors.map((error) => error.message).join("; ")}`,
    );
  }
  return await agentOf(manifest, { isRoot: true, name: manifest.agentId });
}

async function agentOf(
  manifest: AgentSourceManifest,
  identity: { readonly isRoot: boolean; readonly name: string },
): Promise<DefinedAgent> {
  refuseWhatNeedsABuild(manifest);
  const config = await configOf(manifest);
  const { build: _build, defaultTools, tool, ...configuration } = config;
  if (tool !== undefined && tool !== true) {
    throw new Error(
      `${where(manifest)}: "tool: ${JSON.stringify(tool)}" needs the agent's build: an agent defined in code exposes each subagent as a tool.`,
    );
  }
  const instructions = sourcesOf(manifest, "instructions");
  if (instructions.length > 1) {
    throw new Error(`${where(manifest)}: more than one instructions file needs the agent's build.`);
  }
  const [instruction] = instructions;
  const subagents: Record<string, DefinedAgent> = {};
  for (const subagent of manifest.subagents) {
    subagents[subagent.subagentId] = await agentOf(subagent.manifest, {
      isRoot: false,
      name: subagent.subagentId,
    });
  }
  const definition: AgentDefinition = {
    ...configuration,
    connections: Object.fromEntries(
      sourcesOf(manifest, "connection").map((source) => [
        slugOf(source),
        lazy<unknown>(manifest, source),
      ]),
    ),
    // eve's defaults, as the compiler adds them: every node's, and the root's `agent` tool.
    definitions:
      defaultTools === false ? [] : eve.defaults({ without: identity.isRoot ? [] : ["agent"] }),
    instructions:
      instruction === undefined ? undefined : await instructionsOf(manifest, instruction),
    name: identity.name,
    skills: Object.fromEntries(
      sourcesOf(manifest, "skill").map((source) => {
        switch (source.sourceKind) {
          case "markdown":
            return [slugOf(source), source.definition];
          case "module":
            return [slugOf(source), lazy<SkillDefinition | null>(manifest, source)];
          default:
            throw new Error(
              `${where(manifest)}: a skill package (${source.logicalPath}) needs the agent's build.`,
            );
        }
      }),
    ),
    subagents,
    tools: Object.fromEntries(
      sourcesOf(manifest, "tool").map((source) => [slugOf(source), lazyTool(manifest, source)]),
    ),
  };
  return defineAgent(definition);
}

function refuseWhatNeedsABuild(manifest: AgentSourceManifest): void {
  for (const source of manifest.sources) {
    const kind = Object.keys(NEEDS_A_BUILD).find(
      (candidate) => sourcesOf({ sources: [source] }, candidate as AgentSourceKind).length > 0,
    ) as AgentSourceKind | undefined;
    if (kind !== undefined) {
      throw new Error(
        `${where(manifest)}: ${source.logicalPath} needs the agent's build (eve build): ${NEEDS_A_BUILD[kind]}.`,
      );
    }
  }
  if (manifest.extensions.length > 0) {
    throw new Error(
      `${where(manifest)}: extensions need the agent's build (eve build): they mount compiled packages.`,
    );
  }
  if (manifest.sandboxWorkspaces.length > 0) {
    throw new Error(
      `${where(manifest)}: sandbox/workspace/ needs the agent's build (eve build): it's copied into the template.`,
    );
  }
}

/** `agent.ts`'s configuration: what `defineAgent` returned there. */
async function configOf(manifest: AgentSourceManifest): Promise<AgentDefinition> {
  if (manifest.configModule === undefined) {
    throw new Error(`${where(manifest)}: an agent loaded from a directory needs its agent.ts.`);
  }
  const value = await importExport(manifest, manifest.configModule);
  if (isDynamicSentinel(value) || !isDefinedAgent(value)) {
    throw new Error(
      `${where(manifest)}: ${manifest.configModule.logicalPath} must export defineAgent({ ... }); a dynamic subagent needs the agent's build.`,
    );
  }
  return value;
}

/**
 * A file's value, imported the first time it's asked for, and `defineDynamic()`'s evaluated. The
 * builder it reaches checks its shape, as it checks a compiled file's.
 */
function lazy<T>(manifest: AgentSourceManifest, source: ModuleSourceRef) {
  let loaded: Promise<unknown> | undefined;
  return async (ctx: DynamicContext): Promise<T> => {
    const value = await (loaded ??= importExport(manifest, source));
    return (isDynamicSentinel(value) ? await dynamicEvaluate(value)(ctx) : value) as T;
  };
}

/**
 * The agent's instructions file as `defineAgent`'s `instructions`: its text, the same in every
 * session, or a `defineDynamic()` chosen per session. A module is imported now, as the compiler
 * does, to tell which. Instructions for the user's turn have no `defineAgent` field yet.
 */
async function instructionsOf(
  manifest: AgentSourceManifest,
  source: InstructionsSourceRef,
): Promise<AgentDefinition["instructions"]> {
  const value =
    source.sourceKind === "markdown" ? source.definition : await importExport(manifest, source);
  if (isDynamicSentinel(value)) {
    const evaluate = dynamicEvaluate(value);
    return async (ctx) => systemContentOf(manifest, source, await evaluate(ctx));
  }
  return systemContentOf(manifest, source, value);
}

function systemContentOf(
  manifest: AgentSourceManifest,
  source: InstructionsSourceRef,
  value: unknown,
): string | null {
  if (value === null || typeof value === "string") return value;
  const { content, role } = value as { readonly content: string; readonly role?: string };
  if (role !== undefined && role !== "system") {
    throw new Error(
      `${where(manifest)}: ${source.logicalPath} gives instructions for the user's turn, which need the agent's build.`,
    );
  }
  return content;
}

/** A tool file's tool, as {@link lazy}; a workflow tool needs Workflow's build transform. */
function lazyTool(manifest: AgentSourceManifest, source: ModuleSourceRef) {
  const load = lazy<AnyTool | null>(manifest, source);
  return async (ctx: DynamicContext) => {
    const tool = await load(ctx);
    if (isWorkflowToolDefinition(tool)) {
      throw new Error(
        `${where(manifest)}: ${source.logicalPath} is a workflow tool, which needs the agent's build (eve build): Workflow transforms its steps.`,
      );
    }
    return tool;
  };
}

async function importExport(manifest: AgentSourceManifest, source: ModuleSourceRef) {
  const namespace = (await import(
    pathToFileURL(join(manifest.agentRoot, source.logicalPath)).href
  )) as Record<string, unknown>;
  return namespace[source.exportName ?? "default"];
}

/** A file's name in its folder: `tools/deploy.ts` is `deploy`. */
function slugOf(source: { readonly logicalPath: string }): string {
  const base = source.logicalPath.split("/").at(-1)!;
  return base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
}

const where = (manifest: AgentSourceManifest) => `The agent at ${manifest.agentRoot}`;
