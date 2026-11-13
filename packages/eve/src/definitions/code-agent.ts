import { type DynamicContext } from "#dynamic/definition.js";
import type { AgentRoster } from "#execution/agent-sessions/roster.js";
import {
  defineInstructions as brandInstructions,
  type InstructionsDefinition,
} from "#public/definitions/instructions.js";
import { defineSkill as brandSkill, type SkillDefinition } from "#public/definitions/skill.js";
import { createRuntimeAdapterRegistry } from "#runtime/channels/registry.js";
import type { SessionAgent } from "#runtime/sessions/session-agent.js";
import type { ResolvedDynamicDefinition } from "#runtime/types.js";
import type {
  PublicAgentDynamicModelResult,
  PublicAgentModelSelectionDefinition,
  SessionUsageLimit,
} from "#shared/agent-definition.js";
import { sha256Base64Url } from "#shared/digest.js";
import { NonRetryableError } from "#shared/run-errors.js";
import type { ToolDefinition } from "#tools/definition.js";
import { type AgentContents, settingsOf } from "./agent-definitions.js";
import { connectionDefinition } from "./connections.js";
import type { Definition } from "./definition.js";
import { instructionsDefinition, type StaticInstruction } from "./instructions.js";
import { codeModelDefinition } from "./model.js";
import { createSessionAgent } from "./session-agent.js";
import { skillDefinition } from "./skills.js";
import { toolsDefinition } from "./tools.js";

// An agent defined in code, internally: the same representation an `agent/` directory compiles
// to (`createSessionAgent` over an agent's contents), from fields a program sets. Each field goes
// through the builder its file would, under the id that file would take, so a tool named `deploy`
// here is the tool `agent/tools/deploy.ts` would be. Its sessions run where the program holds it:
// a step boundary carries it by its name (`holdSessionAgent`). Nothing public builds one yet.

// oxlint-disable-next-line typescript/no-explicit-any -- any tool, whatever its input and output.
type AnyTool = ToolDefinition<any, any>;

/** A value, or a function of the call's context that returns it, as `defineDynamic` takes. */
type Dynamic<T> = T | ((ctx: DynamicContext) => T | Promise<T>);

/** What an agent defined in code sets, as `agent.ts` and the files beside it would. */
export interface CodeAgentDefinition {
  /** The agent's id, as events and traces name it, and as a step boundary carries it. */
  readonly name: string;
  /** The model: a gateway id, a provider model, or a selection, or a function choosing one. */
  readonly model: Dynamic<PublicAgentDynamicModelResult>;
  /** `instructions.md`'s text, or `agent/instructions/agent.ts`'s, chosen per session. */
  readonly instructions?:
    | string
    | ((ctx: DynamicContext) => Promise<string | null> | string | null);
  /** `agent/tools/<name>.ts`, by name. */
  readonly tools?: Readonly<Record<string, Dynamic<AnyTool | null>>>;
  /** `agent/skills/<name>.ts`, by name. */
  readonly skills?: Readonly<Record<string, Dynamic<SkillDefinition | null>>>;
  /** `agent/connections/<name>.ts`, by name. */
  readonly connections?: Readonly<Record<string, Dynamic<unknown>>>;
  /** Further definitions, placed as an agent's `definitions` are. */
  readonly definitions?: readonly Definition[];
  readonly limits?: {
    readonly sessionTimeoutMs?: number | false;
    readonly sessionUsage?: SessionUsageLimit | false;
  };
  /** `experimental.workflow.modelCallsPerStep`. */
  readonly modelCallsPerStep?: number;
  /**
   * The program's version of the agent's code. The revision digests the agent's names, which don't
   * change when a tool's code does, so a program that changes code under the same names bumps it.
   */
  readonly version?: string;
}

/** The context window a model ID or provider assumes when the agent doesn't say. */
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

/** The session agent `definition` describes. */
export function codeAgent(definition: CodeAgentDefinition): SessionAgent {
  const { name } = definition;
  return createSessionAgent({
    adapters: createRuntimeAdapterRegistry({ channels: [] }),
    connections: () => (definition.connections === undefined ? undefined : []),
    contents: async () => contentsOf(definition),
    // It delegates to no agent yet: a workflow tool's `ctx.agents` is empty.
    delegates: () => ({}),
    id: () => name,
    name: () => name,
    reference: () => ({ id: name, kind: "runtime" }),
    revision: async () => codeAgentRevision(definition),
    roster: () => noSubagents,
    // It opens no sandbox yet.
    sandbox: async () => undefined,
    settings: () =>
      settingsOf({
        modelCallsPerStep: definition.modelCallsPerStep,
        sessionTimeoutMs: definition.limits?.sessionTimeoutMs,
        sessionUsage: () => definition.limits?.sessionUsage,
      }),
  });
}

/** `definition`'s fields as an agent's contents, each through the builder its file would use. */
function contentsOf(definition: CodeAgentDefinition): AgentContents {
  const { instructions } = definition;
  const named = <T>(fields: Readonly<Record<string, T>> | undefined) =>
    Object.entries(fields ?? {});
  return {
    connections: named(definition.connections).map(([name, connection]) =>
      connectionDefinition(source("connection", "connections", name, evaluateOf(connection))),
    ),
    definitions: definition.definitions ?? [],
    instructions: typeof instructions === "function" ? [dynamicInstructions(instructions)] : [],
    model: [
      codeModelDefinition({
        choose: async (ctx) => withContextWindow(await evaluateOf(definition.model)(ctx)),
        label: "code#model",
      }),
    ],
    skills: named(definition.skills).map(([name, skill]) => {
      const evaluate = evaluateOf(skill);
      return skillDefinition(
        source("skill", "skills", name, async (ctx) => {
          const value = await evaluate(ctx);
          return value === null ? null : brandSkill({ ...value });
        }),
      );
    }),
    staticInstructions:
      typeof instructions === "string" ? [staticInstructionOf(instructions)] : undefined,
    subagents: [],
    tools: named(definition.tools).map(([name, tool]) =>
      toolsDefinition({ logicalPath: `tools/${name}.ts`, slug: name }, evaluateOf(tool)),
    ),
  };
}

/** A digest of the agent's name, the names of what it declares, and the program's version. */
export function codeAgentRevision(definition: CodeAgentDefinition): string {
  const names = (fields: Readonly<Record<string, unknown>> | undefined) =>
    Object.keys(fields ?? {}).sort();
  const digest = sha256Base64Url(
    JSON.stringify({
      connections: names(definition.connections),
      definitions: (definition.definitions ?? []).map(({ id }) => id).sort(),
      name: definition.name,
      skills: names(definition.skills),
      tools: names(definition.tools),
      version: definition.version ?? null,
    }),
  );
  return `agent:${digest.slice(0, 22)}`;
}

function source<K extends ResolvedDynamicDefinition["kind"]>(
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

/** `instructions` as a function, as `agent/instructions/agent.ts` would hold it. */
function dynamicInstructions(
  instructions: (ctx: DynamicContext) => Promise<string | null> | string | null,
): Definition {
  return instructionsDefinition(
    source("instructions", "instructions", "agent", async (ctx) => {
      const content = await instructions(ctx);
      return content === null
        ? null
        : brandInstructions({ content } satisfies InstructionsDefinition);
    }),
  );
}

/** A string `instructions`, as the agent's `instructions.md` would state it. */
function staticInstructionOf(content: string): StaticInstruction {
  return { content, name: "instructions", owner: { kind: "application" }, role: "system" };
}

/** A selection with its context window, which a model ID or provider alone doesn't name. */
function withContextWindow(
  chosen: PublicAgentDynamicModelResult,
): PublicAgentModelSelectionDefinition {
  const selection: PublicAgentModelSelectionDefinition =
    typeof chosen === "object" && "model" in chosen && !("modelId" in chosen)
      ? (chosen as PublicAgentModelSelectionDefinition)
      : { model: chosen as PublicAgentModelSelectionDefinition["model"] };
  return {
    ...selection,
    modelContextWindowTokens: selection.modelContextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
  };
}

/** It opens no agent yet: `ctx.agent()` and the agent tool name none it can reach. */
const noSubagents: AgentRoster = {
  childRuntime: (target) => unavailable(target.action.name),
  resolveAction: (_callId, input) => unavailable(input.target),
  runtimeOverrides: async (name) => unavailable(name),
  startTarget: (action) => unavailable(action.name),
};

function unavailable(name: string): never {
  throw new NonRetryableError(`Agent target "${name}" is not available to this agent.`);
}
