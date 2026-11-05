import type { Definition } from "#definitions/definition.js";
import { defineDynamic as defineDynamicBase, type Dynamic } from "#dynamic/definition.js";
import type { ExactDefinition } from "#public/definitions/exact.js";
import type { RemoteAgentDefinition } from "#public/definitions/remote-agent.js";
import type { SkillDefinition } from "#public/definitions/skill.js";
import type {
  PublicAgentDefinition,
  PublicAgentStaticModelDefinition,
} from "#shared/agent-definition.js";
import type { ToolDefinition } from "#tools/definition.js";

/**
 * Cross-instance brand stamped by {@link defineAgent}. The compiler rejects an `agent.ts` export
 * without it, so a plain object can't pass for an agent definition. `Symbol.for` lets the
 * compiler's module copy and the author's import share the key; a symbol key stays out of the
 * `Object.keys`-based shape validators.
 */
const DEFINED_AGENT: unique symbol = Symbol.for("eve.defined-agent");

export type {
  AgentModelOptionsDefinition,
  AgentReasoningDefinition,
  AgentBuildDefinition,
  AgentExperimentalDefinition,
  AgentLimitsDefinition,
  SessionUsageLimit,
  PublicAgentModelSelectionDefinition as AgentModelSelectionDefinition,
  AgentWorkflowDefinition,
  AgentWorkflowRetentionDefinition,
  AgentWorkflowWorldDefinition,
  PublicAgentModelDefinition as AgentModelDefinition,
  PublicAgentStaticModelDefinition as AgentStaticModelDefinition,
  PublicAgentCompactionDefinition as AgentCompactionDefinition,
} from "#shared/agent-definition.js";

// oxlint-disable-next-line typescript/no-explicit-any -- any tool, whatever its input and output.
type AnyTool = ToolDefinition<any, any>;

/**
 * What an `agent/` directory holds as files, as fields of an agent defined in code. `agent.ts`
 * can't set them: the build names the folder to use instead. A value may be a function of the
 * call's context, as a file would make it dynamic with `defineDynamic()`.
 */
export interface AgentContentsDefinition {
  /**
   * The agent's id, `agent` by default. Sessions find the agent by it. A subagent's id is its
   * parent's, then its key in `subagents` (`agent/reviewer`), so this applies only to a root.
   */
  readonly name?: string;
  /** The agent's own instructions, as `agent/instructions.md` would hold them. */
  readonly instructions?: Dynamic<string | null>;
  /** Tools by name, as `agent/tools/<name>.ts` would export them. */
  readonly tools?: Readonly<Record<string, Dynamic<AnyTool | null>>>;
  /** Skills by name, as `agent/skills/<name>.md` would define them. */
  readonly skills?: Readonly<Record<string, Dynamic<SkillDefinition | null>>>;
  /** Connections by name, as `agent/connections/<name>.ts` would export them. */
  readonly connections?: Readonly<Record<string, Dynamic<unknown>>>;
  /**
   * Agents this one delegates to, by name, as `agent/subagents/<name>/agent.ts` would declare
   * them: each is a tool the model calls, which starts a task with that agent. Each needs a
   * `description`.
   */
  readonly subagents?: Readonly<Record<string, DefinedAgent>>;
  /**
   * More definitions, such as eve's default tools. One with the same id as a field's (a tool in
   * `tools` named like a default) is replaced by the field's, where it stood.
   */
  readonly definitions?: readonly Definition[];
  /** Bump when code changes under the same definitions, so kept values are evaluated again. */
  readonly version?: string;
  /** Leave out eve's runtime definitions (approvals, builtins, catalog, skills listing). */
  readonly bare?: boolean;
}

/**
 * An agent: what `agent.ts` exports for an agent built from files, and what an agent defined in
 * code is. Its configuration (`model`, `limits`, `compaction`, `reasoning`, ...) is the same
 * either way; the contents of an `agent/` directory ({@link AgentContentsDefinition}) are fields
 * only an agent defined in code sets.
 *
 * An agent built from files takes its identity from `manifest.agentId` (the package name or
 * app-root basename), so it doesn't author `name`.
 *
 * Declare authentication and network policies on the channel that handles the
 * inbound request, not here. See `eve/channels/auth` for the verifier helpers a
 * channel uses to gate its `fetch` handler.
 */
export type AgentDefinition = PublicAgentDefinition & AgentContentsDefinition;

/** Literal-preserving value returned by {@link defineAgent}, carrying its brand. */
export type DefinedAgent<TAgent extends AgentDefinition = AgentDefinition> = TAgent & {
  readonly [DEFINED_AGENT]: true;
};

/**
 * Agent configuration returned by a dynamic subagent resolver: `defineAgent({ description, model })`.
 * The description tells the parent agent when to delegate.
 */
export type DynamicLocalSubagentDefinition = DefinedAgent<
  Extract<AgentDefinition, { readonly model: PublicAgentStaticModelDefinition }> & {
    readonly description: string;
  }
>;

/** Definition a dynamic subagent resolver may select at runtime. */
export type DynamicSubagentDefinition = DynamicLocalSubagentDefinition | RemoteAgentDefinition;

/** What a dynamic subagent resolves to: the subagent, or `null` to omit it. */
export type DynamicSubagentResult = DynamicSubagentDefinition | null;

/**
 * Defines a value that depends on the session; see `defineDynamic` from `eve/tools` and the other
 * folders' entry points. In `agent.ts` it makes the `model` field dynamic, and its function can't
 * read `ctx.model`. In `subagents/<name>/agent.ts` it makes the whole subagent dynamic: its
 * function returns `defineAgent({ description, model })`, a remote agent, or `null` to omit it.
 *
 * ```ts
 * export default defineDynamic((ctx) =>
 *   ctx.session.auth.current?.attributes.plan === "enterprise"
 *     ? defineAgent({ description: "Analyze financial data.", model: ctx.model.id })
 *     : null,
 * );
 * ```
 */
export const defineDynamic = defineDynamicBase;

/**
 * Defines an agent: the configuration `agent.ts` exports, or an agent defined in code. Returns the
 * same object, preserving its literal type, stamped with the brand eve requires: a plain object is
 * rejected.
 *
 * TypeScript checks the argument against {@link AgentDefinition}: any key outside that shape is a
 * compile error. In `agent.ts` the build also rejects the fields only code takes
 * ({@link AgentContentsDefinition}), naming the folder to use.
 */
export function defineAgent<TAgent extends AgentDefinition>(
  definition: ExactDefinition<TAgent, AgentDefinition>,
): DefinedAgent<TAgent>;
export function defineAgent(definition: AgentDefinition): DefinedAgent {
  Object.defineProperty(definition, DEFINED_AGENT, { configurable: true, value: true });
  return definition as DefinedAgent;
}

/** Whether `value` came from {@link defineAgent}. */
export function isDefinedAgent(value: unknown): value is DefinedAgent {
  return typeof value === "object" && value !== null && Reflect.get(value, DEFINED_AGENT) === true;
}
