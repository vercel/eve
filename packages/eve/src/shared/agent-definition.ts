import type { CallSettings, LanguageModel } from "ai";
import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import type { JsonObject } from "#shared/json.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import {
  isDynamicSentinel,
  type DynamicResolveContext,
  type DynamicSentinel,
} from "#shared/dynamic-tool-definition.js";

/**
 * Optional overrides that eve forwards to the AI SDK model runtime call for
 * this model.
 */
export interface AgentModelOptionsDefinition {
  readonly providerOptions?: Record<string, JsonObject>;
}

/**
 * Provider-agnostic reasoning effort forwarded to the AI SDK model call.
 */
export type AgentReasoningDefinition = NonNullable<CallSettings["reasoning"]>;

/**
 * How an agent's model is reached at runtime, decided at compile time from the
 * authored model value.
 *
 * - `gateway`: routed through the Vercel AI Gateway. This covers a bare model
 *   id string (resolved via the AI SDK global default provider), a
 *   `gateway(...)` instance, and a gateway id whose provider key is forwarded
 *   to the gateway via `providerOptions.gateway.byok`. `target` is the upstream
 *   provider slug carried in the model id (e.g. `"anthropic"`), best-effort.
 *   `byok` is set to that provider slug when a `providerOptions.gateway.byok`
 *   block is present.
 * - `external`: a direct provider instance (e.g. `anthropic(...)`) that bypasses
 *   the gateway and talks to the provider's own endpoint. `provider` is the AI
 *   SDK provider name (e.g. `"anthropic"`).
 *
 * This is a routing fact, not a model-existence check; it does not assert the
 * model id names a real model.
 */
export type ModelRouting =
  | { kind: "gateway"; target: string; byok?: string }
  | { kind: "external"; provider: string };

export type InternalAgentModelDefinition = {
  id: string;
  contextWindowTokens?: number;
  source?: ModuleSourceRef;
  providerOptions?: Record<string, JsonObject>;
};

/**
 * A concrete model handle: an AI Gateway model id string or an AI SDK
 * `LanguageModel` instance.
 */
export type PublicAgentStaticModelDefinition = string | LanguageModel;

/** Context passed to dynamic model event handlers; the shared dynamic resolver context. */
export type AgentModelResolveContext = DynamicResolveContext;

export interface PublicAgentModelSelectionDefinition {
  readonly model: PublicAgentStaticModelDefinition;
  /** Context window of the selected model, in tokens; never inherited from the fallback. */
  readonly modelContextWindowTokens?: number;
  /** Provider options for the selected model; defaults to the agent-level `modelOptions`. */
  readonly modelOptions?: AgentModelOptionsDefinition;
}

export type PublicAgentDynamicModelResult =
  | PublicAgentStaticModelDefinition
  | PublicAgentModelSelectionDefinition
  | null;

export type AgentModelResolver = (
  event: unknown,
  ctx: AgentModelResolveContext,
) => PublicAgentDynamicModelResult | Promise<PublicAgentDynamicModelResult>;

export type PublicAgentDynamicModelDefinition = DynamicSentinel<
  PublicAgentDynamicModelResult,
  PublicAgentStaticModelDefinition
>;

export interface PublicAgentDynamicModelDefinitionInput {
  /** Compiled static model: build-time metadata and the active model when no scope is set. */
  readonly fallback: PublicAgentStaticModelDefinition;
  readonly events: DynamicSentinel<PublicAgentDynamicModelResult>["events"];
}

export function isDynamicModelDefinition(
  value: unknown,
): value is PublicAgentDynamicModelDefinition {
  return isDynamicSentinel(value) && "fallback" in value;
}

/**
 * The model handle you assign to an agent's `model` field.
 */
export type PublicAgentModelDefinition =
  | PublicAgentStaticModelDefinition
  | PublicAgentDynamicModelDefinition;

export interface InternalAgentCompactionDefinition {
  /**
   * Optional model used only for generating compaction summaries.
   *
   * When omitted, eve uses the active turn model for the summary call.
   */
  model?: InternalAgentModelDefinition;
  /**
   * Fraction of the primary model context window that triggers compaction.
   *
   * eve defaults to `0.9` when this is omitted.
   */
  thresholdPercent?: number;
}

/**
 * Configures conversation compaction: when the model context window fills past
 * `thresholdPercent`, eve summarizes earlier turns to reclaim space. Every
 * field is optional; omit the block to use eve's defaults.
 */
export interface PublicAgentCompactionDefinition {
  /**
   * Optional override for the compaction summary model's context window size,
   * in tokens.
   *
   * Same escape hatch as the agent-level `modelContextWindowTokens`. When set,
   * eve uses this value verbatim and skips the AI Gateway lookup for the
   * compaction summary model.
   */
  readonly modelContextWindowTokens?: number;
  /**
   * Optional model used only for generating compaction summaries.
   *
   * When omitted, eve uses the active turn model for the summary call.
   */
  readonly model?: PublicAgentStaticModelDefinition;
  /**
   * Fraction of the primary model context window that triggers compaction.
   *
   * eve defaults to `0.9` when this is omitted.
   */
  readonly thresholdPercent?: number;
}

/**
 * Configures framework-owned runtime limits for this agent's runs.
 */
export interface AgentLimitsDefinition {
  /**
   * Maximum provider-reported input tokens accumulated by one durable session.
   *
   * eve checks this before starting each model call. The model call that crosses
   * the limit is allowed to finish because providers only report exact usage
   * after the call completes; later model calls in the same session are blocked.
   *
   * `false` disables the limit: the session is uncapped.
   *
   * Delegated subagent sessions default to the delegating parent's remaining
   * quota at dispatch time, and the parent's remaining quota always caps an
   * authored child limit — a child can never outspend its parent's budget.
   *
   * @default 40_000_000 for root sessions; the parent's remaining quota for delegated subagent sessions
   */
  readonly maxInputTokensPerSession?: number | false;
  /**
   * Maximum provider-reported output tokens accumulated by one durable session.
   *
   * eve checks this before starting each model call. The model call that crosses
   * the limit is allowed to finish because providers only report exact usage
   * after the call completes; later model calls in the same session are blocked.
   *
   * `false` disables the limit. Unset by default; delegated subagent sessions
   * inherit the parent's remaining output quota when the parent has one.
   */
  readonly maxOutputTokensPerSession?: number | false;
}

/**
 * Experimental, opt-in agent capabilities authored in `agent.ts`.
 *
 * These options are unstable and may change or be removed in any release.
 */
export interface AgentExperimentalDefinition {
  /**
   * Durable Workflow runtime configuration. Root agents may use this to select
   * the Workflow world backing sessions and runs.
   */
  readonly workflow?: AgentWorkflowDefinition;
}

/**
 * Advanced hosted-build controls authored in `agent.ts`.
 *
 * These affect packaging and bundling only. They do not affect the runtime
 * prompt or authored execution APIs.
 */
export interface AgentBuildDefinition {
  /**
   * Additional imported package names that eve should keep external and trace
   * into hosted build output. eve also keeps matching imports external while
   * compiling authored TypeScript modules such as tools, channels, and
   * schedules.
   *
   * Prefer this when a package is sensitive to bundling and should ship via
   * `server/node_modules` in hosted output.
   */
  readonly externalDependencies?: string[];
}

/**
 * Package name for a Workflow world module.
 *
 * The package must export either a default factory or a `createWorld` factory.
 * The factory is called at runtime so credentials and deployment-specific
 * options can come from environment variables instead of the compiled manifest.
 */
export type AgentWorkflowWorldDefinition = string;

/**
 * Advanced durable-runtime configuration for eve's Workflow SDK integration.
 */
export interface AgentWorkflowDefinition {
  /**
   * Workflow world module used for durable workflow storage, queueing, hooks,
   * and streaming.
   */
  readonly world?: AgentWorkflowWorldDefinition;
}

/**
 * Compiled-side agent definition. Carries a `name` because the compiler
 * stamps the path-derived `agentId` onto every compiled agent node.
 */
export type InternalAgentDefinition = {
  name: string;
  description?: string;
  build?: AgentBuildDefinition;
  compaction?: InternalAgentCompactionDefinition;
  experimental?: AgentExperimentalDefinition;
  model: InternalAgentModelDefinition;
  outputSchema?: JsonObject;
  reasoning?: AgentReasoningDefinition;
  source?: ModuleSourceRef;
  limits?: AgentLimitsDefinition;
};

/**
 * Shared public definition for an agent.
 *
 * Identity is derived at compile time from `manifest.agentId` (the
 * package name or app-root basename). Authored definitions do not carry
 * a `name` field.
 */
export type PublicAgentDefinition = {
  /**
   * Human-readable description of the agent's purpose. Required for
   * subagents (authored under `subagents/<id>/agent.ts`): surfaced to
   * the parent agent as the lowered subagent tool's description.
   */
  readonly description?: string;
  readonly build?: AgentBuildDefinition;
  readonly compaction?: PublicAgentCompactionDefinition;
  /**
   * Experimental, opt-in capabilities. Unstable, see
   * {@link AgentExperimentalDefinition}.
   */
  readonly experimental?: AgentExperimentalDefinition;
  /**
   * Language model used for agent turns. Accepts an AI Gateway model ID, any AI
   * SDK-compatible language model, or `defineDynamic({ fallback, events })` for
   * scoped dynamic model selection.
   */
  readonly model: PublicAgentModelDefinition;
  /**
   * Optional override for the primary model's context window size, in tokens.
   *
   * Escape hatch for cases where eve cannot resolve the model's metadata via
   * the AI Gateway model catalog (e.g. a custom or unlisted model id). When
   * set, eve uses this value verbatim and skips the AI Gateway lookup. Prefer
   * leaving this unset so eve can stay in sync with provider metadata.
   */
  readonly modelContextWindowTokens?: number;
  readonly modelOptions?: AgentModelOptionsDefinition;
  /**
   * Provider-agnostic reasoning effort for the agent's turn model calls.
   * Support for individual levels depends on the selected model and provider.
   */
  readonly reasoning?: AgentReasoningDefinition;
  /**
   * Framework-owned runtime limits for this agent's runs.
   */
  readonly limits?: AgentLimitsDefinition;
  /**
   * Optional structured return type used when this agent runs in task mode
   * (for example as a subagent, schedule, or remote job). Interactive
   * conversation turns ignore this field unless the client supplies a
   * per-message output schema.
   */
  readonly outputSchema?: StandardJSONSchemaV1<unknown, unknown> | JsonObject;
};
