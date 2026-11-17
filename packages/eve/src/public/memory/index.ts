import type { InstrumentationChannel } from "#shared/instrumentation-channel.js";
import type { ConversationContext } from "#shared/conversation-context.js";
import { createHash } from "node:crypto";

import type { HistoryMessage as ModelMessage } from "#shared/history-message.js";

import type { SessionAuth } from "#context/keys.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { ExactDefinition } from "#public/definitions/exact.js";
import type { SessionFrame } from "#dynamic/definition.js";
import { EVE_INTERNAL_AGENT_WORKSPACE_MEMBER_ENV } from "#internal/application/build-output-environment.js";
import { MEMORY_DEFINITION_BRAND } from "#shared/memory-definition.js";
import {
  EVE_PUBLIC_ROUTE_PREFIX_ENV,
  normalizePublicRoutePrefix,
} from "#shared/public-route-prefix.js";
import { resolveVercelProjectIdFromEnvironment } from "#shared/vercel-project.js";
import type { ToolDefinition } from "#tools/definition.js";

/**
 * What a namespace function receives: the application root, the agent or subagent, and the slot
 * name.
 */
export interface MemoryNamespaceContext {
  readonly appRoot: string;
  readonly node: string;
  readonly slot: string;
}

/**
 * The application domain a memory slot's scope lives in: a string used as is, `null` to turn the
 * slot off, or a function that resolves one. Omit it to use {@link defaultNamespace}.
 */
export type MemoryNamespaceDefinition =
  | string
  | null
  | ((context: MemoryNamespaceContext) => string | null | Promise<string | null>);

/**
 * What a scope function returns: a scope string, a tuple of strings, or `null` to turn the slot
 * off.
 */
export type MemoryScopeResolverResult = string | readonly string[] | null;

/**
 * What a scope function receives: the session's id and authentication and its channel details.
 * Resolve scope from this trusted data, never from model input.
 */
export interface MemoryScopeContext {
  readonly abortSignal: AbortSignal;
  readonly session: {
    readonly id: string;
    readonly auth: SessionAuth;
  };
  readonly channel: InstrumentationChannel;
  /**
   * Where the conversation happens. Its `space`, such as a Slack channel,
   * scopes memory to everyone in that place.
   */
  readonly conversation?: ConversationContext;
}

/**
 * Who or what shares a memory slot's memory: a fixed string, `null` to turn the slot off, or a
 * function that resolves it from the session, such as `byPrincipal`.
 */
export type MemoryScopeDefinition =
  | string
  | null
  | ((
      context: MemoryScopeContext,
    ) => MemoryScopeResolverResult | Promise<MemoryScopeResolverResult>);

/**
 * A memory slot's resolved scope. Partition every provider read and write by `key`, an opaque
 * digest of `namespace` and `value`.
 */
export interface MemoryScope {
  readonly key: string;
  readonly namespace: string;
  readonly value: string | readonly string[];
}

/**
 * A message a provider recalls into model context. Give it a stable `id` so a later recall replaces
 * it instead of adding another copy.
 */
export interface MemoryRecallMessage {
  readonly content: string;
  readonly id?: string;
}

/**
 * What a recall handler returns: messages to add to model context, or `null` or `undefined` to add
 * nothing.
 */
export type MemoryRecallResult =
  | { readonly messages: readonly MemoryRecallMessage[] }
  | null
  | undefined;

/** The turn a memory handler runs for: its id, its new input messages, and its sequence number. */
export interface MemoryTurnContext {
  readonly id: string;
  readonly input: readonly ModelMessage[];
  readonly sequence: number;
}

/**
 * What every memory recall and capture handler receives: the slot's resolved scope, the
 * conversation for the phase, and an `operationId` to use as an idempotency key.
 */
export interface MemoryOperationContext extends SessionContext {
  readonly abortSignal: AbortSignal;
  readonly messages: readonly ModelMessage[];
  readonly operationId: string;
  readonly memory: {
    readonly scope: MemoryScope;
    readonly slot: string;
  };
}

/** Context for `recall["turn.started"]`, which runs before the first model call of a turn. */
export interface MemoryTurnStartedContext extends MemoryOperationContext {
  readonly turn: MemoryTurnContext;
}

/**
 * Context for `capture["turn.completed"]`, which runs with the finished history after a successful
 * turn.
 */
export interface MemoryTurnCompletedContext extends MemoryOperationContext {
  readonly turn: MemoryTurnContext;
}

/**
 * Context for `capture["compaction.requested"]`, with the history compaction is about to rewrite.
 */
export interface MemoryCompactionRequestedContext extends MemoryOperationContext {
  /** The turn the compaction runs in, or `null` for a compaction between turns. */
  readonly turn: MemoryTurnContext | null;
  readonly compaction: {
    readonly modelId: string;
    /** The input tokens that crossed the threshold, or `null` for a requested compaction. */
    readonly usageInputTokens: number | null;
  };
}

/** A provider handler that returns messages to recall into model context. */
export type MemoryRecallHandler<TContext extends MemoryOperationContext> = (
  context: TContext,
) => MemoryRecallResult | Promise<MemoryRecallResult>;

/**
 * A provider handler that reads the conversation and writes what it keeps to the provider's store.
 */
export type MemoryCaptureHandler<TContext extends MemoryOperationContext> = (
  context: TContext,
) => void | Promise<void>;

/**
 * What a provider's `tools()` function receives: the slot's resolved scope, the session, and the
 * channel.
 */
export interface MemoryToolsContext extends Pick<
  SessionFrame,
  "channel" | "conversation" | "session"
> {
  readonly abortSignal: AbortSignal;
  readonly memory: {
    readonly scope: MemoryScope;
    readonly slot: string;
  };
}

/** Tools a memory provider exposes, each created with `defineTool()`, keyed by tool name. */
export type MemoryToolSet = Readonly<Record<string, ToolDefinition<any, any>>>;

/**
 * Storage and retrieval behind a memory slot: a required `recall` handler, optional `capture`
 * handlers, and optional model tools. Create one with {@link defineMemoryProvider}.
 */
export interface MemoryProvider {
  readonly recall: {
    readonly "turn.started": MemoryRecallHandler<MemoryTurnStartedContext>;
  };
  readonly capture?: {
    /**
     * Runs before compaction rewrites history, with the history it rewrites. When it throws, the
     * compaction fails and history stays as it was.
     */
    readonly "compaction.requested"?: MemoryCaptureHandler<MemoryCompactionRequestedContext>;
    readonly "turn.completed"?: MemoryCaptureHandler<MemoryTurnCompletedContext>;
  };
  readonly tools?: (context: MemoryToolsContext) => Promise<MemoryToolSet | null>;
}

/** The fields of a memory slot passed to {@link defineMemory}. */
export interface MemoryDefinition {
  readonly description?: string;
  readonly namespace?: MemoryNamespaceDefinition;
  readonly provider: MemoryProvider;
  readonly scope: MemoryScopeDefinition;
}

/**
 * A memory slot definition returned by {@link defineMemory}, ready to default-export from
 * `agent/memory/<slot>.ts`.
 */
export type DefinedMemory<T extends MemoryDefinition = MemoryDefinition> = T & {
  readonly [MEMORY_DEFINITION_BRAND]: true;
};

/** Defines a memory provider, checking its handlers against {@link MemoryProvider}. */
export function defineMemoryProvider<const T extends MemoryProvider>(
  provider: ExactDefinition<T, MemoryProvider>,
): T {
  return provider;
}

/**
 * Defines a memory slot, which connects a provider to the agent under a scope. Default-export it
 * from `agent/memory.ts` or `agent/memory/<slot>.ts`; the slot name comes from the file path.
 */
export function defineMemory<const T extends MemoryDefinition>(
  definition: ExactDefinition<T, MemoryDefinition>,
): DefinedMemory<T>;
export function defineMemory(definition: MemoryDefinition): DefinedMemory {
  Object.assign(definition, { [MEMORY_DEFINITION_BRAND]: true });
  return definition as DefinedMemory;
}

/**
 * The namespace a memory slot uses when `namespace` is omitted. It combines the slot name, the agent
 * or subagent, and the deployment, so separate Vercel projects, environments, Preview branches, and
 * local application roots do not share memory.
 */
export function defaultNamespace(context: MemoryNamespaceContext): string {
  const projectId = resolveVercelProjectIdFromEnvironment();
  if (projectId === undefined) {
    return JSON.stringify([
      "eve-memory-default-namespace-v1",
      "local",
      createHash("sha256").update(context.appRoot).digest("base64url"),
      context.node,
      context.slot,
    ]);
  }

  const environment =
    process.env.VERCEL_TARGET_ENV?.trim() || process.env.VERCEL_ENV?.trim() || "production";
  const previewIdentity =
    environment === "preview"
      ? process.env.VERCEL_GIT_COMMIT_REF?.trim() ||
        process.env.VERCEL_DEPLOYMENT_ID?.trim() ||
        process.env.VERCEL_URL?.trim() ||
        "unknown-preview"
      : null;
  const publicRoutePrefix =
    process.env[EVE_INTERNAL_AGENT_WORKSPACE_MEMBER_ENV] === "1"
      ? normalizePublicRoutePrefix(process.env[EVE_PUBLIC_ROUTE_PREFIX_ENV])
      : undefined;
  return JSON.stringify([
    "eve-memory-default-namespace-v1",
    "vercel",
    projectId,
    environment,
    previewIdentity,
    ...(publicRoutePrefix === undefined ? [] : [publicRoutePrefix]),
    context.node,
    context.slot,
  ]);
}
