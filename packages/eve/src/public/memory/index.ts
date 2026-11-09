import type { InstrumentationChannel } from "#shared/instrumentation-channel.js";

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
import { readEnv } from "#platform/env.js";
import { sha256Base64Url } from "#shared/digest.js";

export interface MemoryNamespaceContext {
  readonly appRoot: string;
  readonly node: string;
  readonly slot: string;
}

export type MemoryNamespaceDefinition =
  | string
  | null
  | ((context: MemoryNamespaceContext) => string | null | Promise<string | null>);

export type MemoryScopeResolverResult = string | readonly string[] | null;

export interface MemoryScopeContext {
  readonly abortSignal: AbortSignal;
  readonly session: {
    readonly id: string;
    readonly auth: SessionAuth;
  };
  readonly channel: InstrumentationChannel;
}

export type MemoryScopeDefinition =
  | string
  | null
  | ((
      context: MemoryScopeContext,
    ) => MemoryScopeResolverResult | Promise<MemoryScopeResolverResult>);

export interface MemoryScope {
  readonly key: string;
  readonly namespace: string;
  readonly value: string | readonly string[];
}

export interface MemoryRecallMessage {
  readonly content: string;
  readonly id?: string;
}

export type MemoryRecallResult =
  | { readonly messages: readonly MemoryRecallMessage[] }
  | null
  | undefined;

export interface MemoryTurnContext {
  readonly id: string;
  readonly input: readonly ModelMessage[];
  readonly sequence: number;
}

export interface MemoryOperationContext extends SessionContext {
  readonly abortSignal: AbortSignal;
  readonly messages: readonly ModelMessage[];
  readonly operationId: string;
  readonly memory: {
    readonly scope: MemoryScope;
    readonly slot: string;
  };
}

export interface MemoryTurnStartedContext extends MemoryOperationContext {
  readonly turn: MemoryTurnContext;
}

export interface MemoryTurnCompletedContext extends MemoryOperationContext {
  readonly turn: MemoryTurnContext;
}

export interface MemoryCompactionRequestedContext extends MemoryOperationContext {
  /** The turn the compaction runs in, or `null` for a compaction between turns. */
  readonly turn: MemoryTurnContext | null;
  readonly compaction: {
    readonly modelId: string;
    /** The input tokens that crossed the threshold, or `null` for a requested compaction. */
    readonly usageInputTokens: number | null;
  };
}

export type MemoryRecallHandler<TContext extends MemoryOperationContext> = (
  context: TContext,
) => MemoryRecallResult | Promise<MemoryRecallResult>;

export type MemoryCaptureHandler<TContext extends MemoryOperationContext> = (
  context: TContext,
) => void | Promise<void>;

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

// A tool's input and output types appear in both parameter and result positions, so only `any`
// accepts every `defineTool()` result. eve validates input against the tool's schema at runtime.
/** Tools a memory provider exposes, each created with `defineTool()`, keyed by tool name. */
export type MemoryToolSet = Readonly<Record<string, ToolDefinition<any, any>>>;

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

export interface MemoryDefinition {
  readonly description?: string;
  readonly namespace?: MemoryNamespaceDefinition;
  readonly provider: MemoryProvider;
  readonly scope: MemoryScopeDefinition;
}

export type DefinedMemory<T extends MemoryDefinition = MemoryDefinition> = T & {
  readonly [MEMORY_DEFINITION_BRAND]: true;
};

export function defineMemoryProvider<const T extends MemoryProvider>(
  provider: ExactDefinition<T, MemoryProvider>,
): T {
  return provider;
}

export function defineMemory<const T extends MemoryDefinition>(
  definition: ExactDefinition<T, MemoryDefinition>,
): DefinedMemory<T>;
export function defineMemory(definition: MemoryDefinition): DefinedMemory {
  Object.assign(definition, { [MEMORY_DEFINITION_BRAND]: true });
  return definition as DefinedMemory;
}

export function defaultNamespace(context: MemoryNamespaceContext): string {
  const projectId = resolveVercelProjectIdFromEnvironment();
  if (projectId === undefined) {
    return JSON.stringify([
      "eve-memory-default-namespace-v1",
      "local",
      sha256Base64Url(context.appRoot),
      context.node,
      context.slot,
    ]);
  }

  const environment =
    readEnv("VERCEL_TARGET_ENV")?.trim() || readEnv("VERCEL_ENV")?.trim() || "production";
  const previewIdentity =
    environment === "preview"
      ? readEnv("VERCEL_GIT_COMMIT_REF")?.trim() ||
        readEnv("VERCEL_DEPLOYMENT_ID")?.trim() ||
        readEnv("VERCEL_URL")?.trim() ||
        "unknown-preview"
      : null;
  const publicRoutePrefix =
    readEnv(EVE_INTERNAL_AGENT_WORKSPACE_MEMBER_ENV) === "1"
      ? normalizePublicRoutePrefix(readEnv(EVE_PUBLIC_ROUTE_PREFIX_ENV))
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
