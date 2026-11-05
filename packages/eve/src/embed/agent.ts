import type { LanguageModel } from "ai";

import { connectionDefinition } from "#definitions/connections.js";
import type { Definition } from "#definitions/definition.js";
import { agentDefinitionsOf, type AgentContents } from "#definitions/agent-definitions.js";
import { subagentDefinitionOf } from "#definitions/delegation.js";
import { instructionsDefinition, type StaticInstruction } from "#definitions/instructions.js";
import { codeModelDefinition } from "#definitions/model.js";
import { skillDefinition } from "#definitions/skills.js";
import { toolsDefinition } from "#definitions/tools.js";
import type { DynamicContext } from "#dynamic/definition.js";
import { createFrameworkUserMessage } from "#harness/messages.js";
import { currentProjection } from "#harness/session-machine/current.js";
import { activeTurnIdOf, latestTurnIdOf } from "#protocol/session-projection.js";
import {
  defineInstructions as brandInstructions,
  type InstructionsDefinition,
} from "#public/definitions/instructions.js";
import { defineSkill as brandSkill, type SkillDefinition } from "#public/definitions/skill.js";
import { createSessionAgent } from "#runtime/sessions/code-agent.js";
import type { CodeAgent, SessionAgentSettings } from "#runtime/sessions/session-agent.js";
import type { ResolvedDynamicDefinition } from "#runtime/types.js";
import type { AgentReasoningDefinition } from "#shared/agent-definition.js";
import type { ToolDefinition } from "#tools/definition.js";

// Agents defined in code (internal; the public shape comes with `defineAgent`). Each helper makes
// a Definition through the builder an `agent/` directory's file goes through, under the id that
// file would take, so a tool named `deploy` here is the tool `agent/tools/deploy.ts` would be.

/** A value, or a function of the call's dynamic context, as a `defineDynamic()` returns. */
export type Dynamic<T> = T | ((ctx: DynamicContext) => T | Promise<T>);

// oxlint-disable-next-line typescript/no-explicit-any -- any tool, whatever its input and output.
type AnyTool = ToolDefinition<any, any>;

/** The context window a model ID or provider assumes when the selection doesn't say. */
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

/** An agent's model: a gateway ID, a provider model, or a selection with its options. */
export type ModelInput = string | LanguageModel | ModelSelection;

export interface ModelSelection {
  readonly model: string | LanguageModel;
  readonly modelContextWindowTokens?: number;
  readonly reasoning?: AgentReasoningDefinition;
}

/** A selection object, not a model: a provider model has a `modelId` beside its methods. */
function isModelSelection(input: ModelInput): input is ModelSelection {
  return typeof input === "object" && "model" in input && !("modelId" in input);
}

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

/** The agent's model, as `agent.ts`'s dynamic `model` would choose it. */
export function defineModel(model: Dynamic<ModelInput>): Definition {
  const choose = evaluateOf(model);
  return codeModelDefinition({
    choose: async (ctx) => {
      const chosen = await choose(ctx);
      const selection: ModelSelection = isModelSelection(chosen) ? chosen : { model: chosen };
      return {
        ...selection,
        modelContextWindowTokens:
          selection.modelContextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
      };
    },
    label: "code#model",
  });
}

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

/** An agent defined in code, as its `agent/` directory would declare it. */
export interface CodeAgentOptions {
  /** The agent's id, `agent` by default. Sessions find the agent by it. */
  readonly name?: string;
  /** What the agent is for, which a parent's model reads when it's a subagent. */
  readonly description?: string;
  readonly model: Dynamic<ModelInput>;
  /** The agent's own instructions, as `agent/instructions.md` would hold them. */
  readonly instructions?: Dynamic<string | null>;
  /** Tools by name, as `agent/tools/<name>.ts` would export them. */
  readonly tools?: Readonly<Record<string, Dynamic<AnyTool | null>>>;
  /** Skills by name, as `agent/skills/<name>.ts` would define them. */
  readonly skills?: Readonly<Record<string, Dynamic<SkillDefinition | null>>>;
  /** Connections by name, as `agent/connections/<name>.ts` would export them. */
  readonly connections?: Readonly<Record<string, Dynamic<unknown>>>;
  /**
   * Agents it delegates to, by name, as `agent/subagents/<name>/` would declare them: each is a
   * tool the model calls, and `ctx.agent(name)` in a workflow tool. Each needs a `description`.
   */
  readonly subagents?: Readonly<Record<string, CodeAgent>>;
  /** More definitions, after the ones above, such as `defineContext(...)` or `eve.defaults()`. */
  readonly definitions?: readonly Definition[];
  readonly settings?: SessionAgentSettings;
  /** Bump when code changes under the same definitions; see `createSessionAgent`. */
  readonly version?: string;
}

/** The agent `options` declares, with eve's runtime definitions around its own. */
export function codeAgent(options: CodeAgentOptions): CodeAgent {
  const { instructions } = options;
  const contents: AgentContents = {
    connections: Object.entries(options.connections ?? {}).map(([name, connection]) =>
      defineConnection(name, connection),
    ),
    definitions: options.definitions ?? [],
    instructions: typeof instructions === "function" ? [defineInstructions(instructions)] : [],
    model: [defineModel(options.model)],
    skills: Object.entries(options.skills ?? {}).map(([name, skill]) => defineSkill(name, skill)),
    staticInstructions:
      typeof instructions === "string" ? [staticInstructionOf(instructions)] : undefined,
    subagents: Object.entries(options.subagents ?? {}).map(([name, subagent]) =>
      subagentDefinitionOf(name, subagent),
    ),
    tools: Object.entries(options.tools ?? {}).map(([name, tool]) => toolDefinitionOf(name, tool)),
  };
  return createSessionAgent({
    definitions: agentDefinitionsOf(contents),
    description: options.description,
    id: options.name ?? "agent",
    settings: options.settings,
    version: options.version,
  });
}

/** A string `instructions`, as the agent's `instructions.md` would state it. */
function staticInstructionOf(content: string): StaticInstruction {
  return { content, name: "instructions", owner: { kind: "application" }, role: "system" };
}
