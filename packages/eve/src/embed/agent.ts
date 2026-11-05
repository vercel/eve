import { connectionDefinition } from "#definitions/connections.js";
import type { Definition } from "#definitions/definition.js";
import { subagentDefinitionOf } from "#definitions/delegation.js";
import {
  agentDefinitionsOf,
  type AgentContents,
  settingsOf,
} from "#definitions/agent-definitions.js";
import { instructionsDefinition, type StaticInstruction } from "#definitions/instructions.js";
import { codeModelDefinition } from "#definitions/model.js";
import { skillDefinition } from "#definitions/skills.js";
import { toolsDefinition } from "#definitions/tools.js";
import { type Dynamic, type DynamicContext, dynamicEvaluate } from "#dynamic/definition.js";
import { createFrameworkUserMessage } from "#harness/messages.js";
import { currentProjection } from "#harness/session-machine/current.js";
import { normalizeAgentDefinition } from "#internal/authored-definition/core.js";
import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import { activeTurnIdOf, latestTurnIdOf } from "#protocol/session-projection.js";
import {
  type AgentDefinition,
  type DefinedAgent,
  isDefinedAgent,
} from "#public/definitions/agent.js";
import {
  defineInstructions as brandInstructions,
  type InstructionsDefinition,
} from "#public/definitions/instructions.js";
import { defineSkill as brandSkill, type SkillDefinition } from "#public/definitions/skill.js";
import { createSessionAgent } from "#runtime/sessions/code-agent.js";
import type { CodeAgent, SessionAgentSettings } from "#runtime/sessions/session-agent.js";
import type { ResolvedDynamicDefinition } from "#runtime/types.js";
import {
  isDynamicModelDefinition,
  type PublicAgentDefinition,
  type PublicAgentDynamicModelResult,
  type PublicAgentModelSelectionDefinition,
} from "#shared/agent-definition.js";
import type { ToolDefinition } from "#tools/definition.js";

// Agents defined in code: `defineAgent({ ... })`, the function `agent.ts` uses, run as the
// session-agent port's code implementation. Each field of an `agent/` directory becomes a
// Definition through the builder its file goes through, under the id that file would take, so a
// tool named `deploy` here is the tool `agent/tools/deploy.ts` would be; the configuration
// fields (`model`, `limits`, `compaction`, ...) mean what they mean in `agent.ts`. The helpers
// below make definitions for `definitions`.

export type { Dynamic };

// oxlint-disable-next-line typescript/no-explicit-any -- any tool, whatever its input and output.
type AnyTool = ToolDefinition<any, any>;

/** The context window a model ID or provider assumes when the agent doesn't say. */
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

function dynamicSource<K extends ResolvedDynamicDefinition["kind"]>(
  kind: K,
  directory: string,
  name: string,
  evaluate: (ctx: DynamicContext) => unknown,
): ResolvedDynamicDefinition<K> {
  return {
    evaluate,
    kind,
    logicalPath: `${directory}/${name}.ts`,
    slug: name,
    sourceId: "code:agent",
    sourceKind: "module",
  };
}

const evaluateOf =
  <T>(value: Dynamic<T>) =>
  (ctx: DynamicContext): T | Promise<T> =>
    typeof value === "function" ? (value as (ctx: DynamicContext) => T | Promise<T>)(ctx) : value;

/** Instructions, as `agent/instructions/<name>.ts` would hold them: `agent` by default. */
export function defineInstructions(
  content: Dynamic<string | InstructionsDefinition | null>,
  options: { readonly name?: string } = {},
): Definition {
  const evaluate = evaluateOf(content);
  return instructionsDefinition(
    dynamicSource("instructions", "instructions", options.name ?? "agent", async (ctx) => {
      const value = await evaluate(ctx);
      if (value === null) return null;
      return brandInstructions(typeof value === "string" ? { content: value } : { ...value });
    }),
  );
}

/** A tool, as `agent/tools/<name>.ts` would export it. */
export function toolDefinitionOf(name: string, tool: Dynamic<AnyTool | null>): Definition {
  return toolsDefinition({ logicalPath: `tools/${name}.ts`, slug: name }, evaluateOf(tool));
}

/** A skill, as `agent/skills/<name>.ts` would define it. */
export function defineSkill(name: string, skill: Dynamic<SkillDefinition | null>): Definition {
  const evaluate = evaluateOf(skill);
  return skillDefinition(
    dynamicSource("skill", "skills", name, async (ctx) => {
      const value = await evaluate(ctx);
      return value === null ? null : brandSkill({ ...value });
    }),
  );
}

/**
 * A connection, as `agent/connections/<name>.ts` would export it: `defineMcpClientConnection(...)`
 * or `defineOpenAPIConnection(...)`, or a function of the call's context returning one. Its tools
 * reach the model through eve's catalog, as a file agent's do.
 */
export function defineConnection(name: string, connection: Dynamic<unknown>): Definition {
  return connectionDefinition(
    dynamicSource("connection", "connections", name, evaluateOf(connection)),
  );
}

/**
 * Context for every model call: what `content` returns joins the call just ahead of the turn's
 * input, and is asked again on the next call. `undefined` adds nothing.
 */
export function defineContext(
  name: string,
  content: () => string | undefined | Promise<string | undefined>,
): Definition {
  return {
    contribute: ({ container }) => ({
      context: async () => {
        const projection = currentProjection(container);
        const turnId = activeTurnIdOf(projection) ?? latestTurnIdOf(projection);
        if (turnId === undefined) return [];
        const text = await content();
        if (text === undefined || text === "") return [];
        return [{ message: createFrameworkUserMessage("context.state", text), turnId }];
      },
    }),
    id: `context:${name}`,
    label: `the ${name} context`,
  };
}

/**
 * The fields of `agent.ts` that don't apply to an agent defined in code, and why: they configure
 * an `agent/` directory's build or a deployment, which an agent defined in code doesn't have.
 */
const FILE_ONLY_FIELDS = {
  build: "it configures how eve build bundles an agent/ directory",
  defaultTools:
    "an agent defined in code has the tools its definitions add, such as eve's default tools",
  tool: "a parent exposes each subagent defined in code as a tool",
} as const;

/** What each object `defineAgent` returned runs as: built on first use, then the same agent. */
const built = new WeakMap<DefinedAgent, CodeAgent>();

/**
 * The agent `defined` declares, as sessions run it: eve's runtime definitions around its own. It
 * is built once per object, so its fields are read on first use; define another agent to change
 * them.
 */
export function codeAgentOf(defined: DefinedAgent): CodeAgent {
  if (!isDefinedAgent(defined)) {
    throw new Error("Pass the agent defineAgent({ ... }) returns, not a plain object.");
  }
  let agent = built.get(defined);
  if (agent === undefined) {
    agent = buildCodeAgent(defined);
    built.set(defined, agent);
  }
  return agent;
}

function buildCodeAgent(defined: AgentDefinition): CodeAgent {
  const {
    bare,
    connections,
    definitions,
    instructions,
    name,
    skills,
    subagents,
    tools,
    version,
    ...configuration
  } = defined;
  const id = name ?? "agent";
  rejectFileOnlyFields(configuration, id);
  const config = normalizeAgentDefinition(
    configuration,
    `The agent "${id}" doesn't match defineAgent's shape.`,
  );
  const contents: AgentContents = {
    bare,
    connections: Object.entries(connections ?? {}).map(([connectionName, connection]) =>
      defineConnection(connectionName, connection),
    ),
    definitions: definitions ?? [],
    instructions: typeof instructions === "function" ? [defineInstructions(instructions)] : [],
    model: [modelDefinition(config)],
    skills: Object.entries(skills ?? {}).map(([skillName, skill]) => defineSkill(skillName, skill)),
    staticInstructions:
      typeof instructions === "string" ? [staticInstructionOf(instructions)] : undefined,
    subagents: Object.entries(subagents ?? {}).map(([subagentName, subagent]) =>
      subagentDefinitionOf(subagentName, codeAgentOf(subagent)),
    ),
    tools: Object.entries(tools ?? {}).map(([toolName, tool]) => toolDefinitionOf(toolName, tool)),
  };
  return createSessionAgent({
    definitions: agentDefinitionsOf(contents),
    description: config.description,
    id,
    settings: codeSettings(config, id),
    version,
  });
}

function rejectFileOnlyFields(configuration: Readonly<Record<string, unknown>>, id: string): void {
  const fields: [string, string][] = Object.entries(FILE_ONLY_FIELDS).filter(
    ([field]) => configuration[field] !== undefined,
  );
  const world = (configuration.experimental as PublicAgentDefinition["experimental"])?.workflow
    ?.world;
  if (world !== undefined) {
    fields.push(["experimental.workflow.world", "the host's Workflow runtime picks its world"]);
  }
  const [first] = fields;
  if (first !== undefined) {
    const [field, why] = first;
    throw new Error(
      `The agent "${id}" is defined in code, so "${field}" doesn't apply: ${why}. Remove it.`,
    );
  }
  if (configuration.approval !== undefined) {
    throw new Error(
      `The agent "${id}" is defined in code, and an agent-wide "approval" isn't supported there yet. Set each tool's approval instead, or eve's default tools' approval.`,
    );
  }
}

type AgentConfig = ReturnType<typeof normalizeAgentDefinition>;

/** The agent's model, chosen as `agent.ts`'s `model` would choose it: static, or per call. */
function modelDefinition(config: AgentConfig): Definition {
  const { model } = config;
  const choose: (ctx: DynamicContext) => unknown = isDynamicModelDefinition(model)
    ? dynamicEvaluate(model)
    : () => ({
        model,
        modelContextWindowTokens: config.modelContextWindowTokens,
        modelOptions: config.modelOptions,
      });
  return codeModelDefinition({
    choose: async (ctx) => withContextWindow((await choose(ctx)) as PublicAgentDynamicModelResult),
    label: "code#model",
  });
}

/** A selection with its context window, which a model ID or provider alone doesn't name. */
function withContextWindow(
  chosen: PublicAgentDynamicModelResult,
): PublicAgentModelSelectionDefinition {
  const selection: PublicAgentModelSelectionDefinition = isModelSelection(chosen)
    ? chosen
    : { model: chosen };
  return {
    ...selection,
    modelContextWindowTokens: selection.modelContextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
  };
}

/** A selection object, not a model: a provider model has a `modelId` beside its methods. */
function isModelSelection(
  chosen: PublicAgentDynamicModelResult,
): chosen is PublicAgentModelSelectionDefinition {
  return typeof chosen === "object" && "model" in chosen && !("modelId" in chosen);
}

/** A string `instructions`, as the agent's `instructions.md` would state it. */
function staticInstructionOf(content: string): StaticInstruction {
  return { content, name: "instructions", owner: { kind: "application" }, role: "system" };
}

/** The agent's configuration as `settingsOf` takes it, as the compiler resolves `agent.ts`'s. */
function codeSettings(config: AgentConfig, id: string): SessionAgentSettings {
  const { compaction, limits } = config;
  const workflow = config.experimental?.workflow;
  return settingsOf({
    compactionModel:
      compaction?.model === undefined
        ? undefined
        : compactionModel(compaction.model, compaction.modelContextWindowTokens, id),
    compactionThresholdPercent: compaction?.threshold,
    modelCallsPerStep: workflow?.modelCallsPerStep,
    reasoning: config.reasoning,
    retention: workflow?.retention,
    sessionTimeoutMs: limits?.sessionTimeoutMs,
    sessionUsage: () => limits?.sessionUsage,
  });
}

/**
 * The compaction summary's model. eve resolves it by id when it compacts, and an agent defined in
 * code has no module to load a provider object from again, so it takes a model id.
 */
function compactionModel(
  model: NonNullable<NonNullable<AgentConfig["compaction"]>["model"]>,
  contextWindowTokens: number | undefined,
  id: string,
): NonNullable<NonNullable<SessionAgentSettings["compaction"]>["model"]> {
  if (typeof model !== "string") {
    throw new Error(
      `The agent "${id}" is defined in code, so its compaction.model is a model id, such as "anthropic/claude-haiku-4.5": eve loads the compaction model by id.`,
    );
  }
  return { contextWindowTokens, id: formatLanguageModelGatewayId(model) };
}
