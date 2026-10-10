import type {
  AgentBuildDefinition,
  PublicAgentDefinition,
  PublicAgentStaticModelDefinition,
} from "#shared/agent-definition.js";
import type { ExactDefinition } from "#public/definitions/exact.js";
import type { RemoteAgentDefinition } from "#public/definitions/remote-agent.js";
import { defineDynamic as defineDynamicBase } from "#dynamic/definition.js";
import type { DynamicDefinition, DynamicSentinel } from "#dynamic/definition.js";

declare const DEFINED_AGENT: unique symbol;

export type {
  AgentModelOptionsDefinition,
  AgentReasoningDefinition,
  AgentBuildDefinition,
  AgentExperimentalDefinition,
  AgentLimitsDefinition,
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

/** Static fields a dynamic subagent declares beside `select` and `resolve`. */
export interface DynamicSubagentStaticFields {
  readonly build?: AgentBuildDefinition;
  readonly defaultTools?: boolean;
}

/** What a dynamic subagent resolves to: the subagent, or `null` to omit it. */
export type DynamicSubagentResult = DynamicSubagentDefinition | null;

/**
 * Makes a whole subagent dynamic: `resolve` returns `defineAgent({ description, model })`, a
 * remote agent, or `null` to omit it, and eve calls it again when `select` changes. Packaging
 * fields, `build` and `defaultTools`, sit beside `select` and `resolve`.
 *
 * To keep a subagent's description and choose only its model per session, export `defineAgent()`
 * with a dynamic `model` field instead: `defineDynamic` from `eve/models`, or `auto()`.
 *
 * ```ts
 * export default defineDynamic({
 *   select: (_view, ctx) => ctx.session.auth.current?.attributes?.role === "finance",
 *   resolve: (finance) =>
 *     finance ? defineAgent({ description: "Answer billing questions.", model: "zai/glm-5.2" }) : null,
 * });
 * ```
 */
export function defineDynamic<TSelected = null>(
  definition: DynamicDefinition<TSelected, DynamicSubagentResult> & DynamicSubagentStaticFields,
): DynamicSentinel<DynamicSubagentResult, TSelected> & DynamicSubagentStaticFields {
  return defineDynamicBase(definition);
}

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
