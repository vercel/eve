import type {
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

/** Static fields a dynamic `agent.ts` declares beside `select` and `resolve`. */
export type DynamicAgentStaticFields = Omit<
  DynamicLocalSubagentDefinition,
  "description" | "model" | "modelContextWindowTokens" | "modelOptions"
> & { readonly description?: string };

/** What a dynamic `agent.ts` resolves to. */
export type DynamicAgentResult = AgentDefinition | RemoteAgentDefinition | null;

/**
 * Makes `agent.ts` dynamic: `resolve` returns `defineAgent(...)` for the session, and eve calls
 * it again when `select` changes. In the root agent it chooses the model, its options, and
 * reasoning; in `subagents/<name>/agent.ts` it chooses the whole subagent, which needs a
 * description so its parent knows when to delegate, or `null` to omit it. Fields that can't vary
 * per session, such as `build` or `compaction`, sit beside `select` and `resolve`.
 *
 * ```ts
 * export default defineDynamic({
 *   select: (view) => view.messages.some(hasImage),
 *   resolve: (image) => defineAgent({ model: image ? "google/gemini-3.5-flash" : "zai/glm-5.2" }),
 * });
 * ```
 */
export function defineDynamic<TSelected = null>(
  definition: DynamicDefinition<TSelected, DynamicAgentResult> & Partial<DynamicAgentStaticFields>,
): DynamicSentinel<DynamicAgentResult, TSelected> & Partial<DynamicAgentStaticFields> {
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
