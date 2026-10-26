import type {
  PublicAgentDefinition,
  PublicAgentStaticModelDefinition,
} from "#shared/agent-definition.js";
import type { ExactDefinition } from "#public/definitions/exact.js";
import type { RemoteAgentDefinition } from "#public/definitions/remote-agent.js";
import { defineDynamic as defineDynamicBase } from "#dynamic/definition.js";

declare const DEFINED_AGENT: unique symbol;

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

/**
 * Additive public agent configuration authored in `agent.ts`.
 *
 * The compiler derives identity at compile time from `manifest.agentId` (the
 * package name or app-root basename), so do not author a `name` field.
 *
 * Declare authentication and network policies on the channel that handles the
 * inbound request, not here. See `eve/channels/auth` for the verifier helpers a
 * channel uses to gate its `fetch` handler.
 */
export type AgentDefinition = PublicAgentDefinition;

/** Literal-preserving value returned by {@link defineAgent}. */
export type DefinedAgent<TAgent extends AgentDefinition = AgentDefinition> = TAgent & {
  readonly [DEFINED_AGENT]: true;
};

/**
 * Agent configuration returned by a dynamic subagent resolver. The description
 * tells the parent agent when to delegate.
 */
export type DynamicLocalSubagentDefinition = Extract<
  AgentDefinition,
  { readonly model: PublicAgentStaticModelDefinition }
> & { readonly description: string };

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
 * Defines the agent configuration authored in `agent.ts` and returns it
 * unchanged, preserving its literal type.
 *
 * TypeScript checks the argument against {@link AgentDefinition}: any key outside
 * that shape is a compile error. The compiler derives identity (the agent name)
 * at compile time from `manifest.agentId` (the package name or app-root
 * basename), so do not author a `name` field.
 */
export function defineAgent<TAgent extends AgentDefinition>(
  definition: ExactDefinition<TAgent, AgentDefinition>,
): DefinedAgent<TAgent>;
export function defineAgent(definition: AgentDefinition): AgentDefinition {
  return definition;
}
