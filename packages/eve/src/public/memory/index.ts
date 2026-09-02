import { createHash } from "node:crypto";

import type { ModelMessage } from "ai";

import type { SessionAuth } from "#context/keys.js";
import type { Approval } from "#public/definitions/approval.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { ExactDefinition } from "#public/definitions/exact.js";
import type { DynamicResolveContext } from "#dynamic/definition.js";
import { MEMORY_DEFINITION_BRAND } from "#shared/memory-definition.js";
import { resolveVercelProjectIdFromEnvironment } from "#shared/vercel-project.js";
import type { ToolContext, ToolModelOutput } from "#tools/definition.js";

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
  readonly channel: {
    readonly kind?: string;
    readonly continuationToken?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
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

export interface MemoryCompactionCompletedContext extends MemoryOperationContext {
  readonly turn: MemoryTurnContext | null;
  readonly compaction: { readonly modelId: string };
}

export interface MemoryCompactionRequestedContext extends MemoryOperationContext {
  readonly turn: MemoryTurnContext | null;
  readonly compaction: {
    readonly modelId: string;
    readonly usageInputTokens: number | null;
  };
}

export interface MemoryTurnCompletedContext extends MemoryOperationContext {
  readonly turn: MemoryTurnContext;
}

export type MemoryRecallHandler<TContext extends MemoryOperationContext> = (
  context: TContext,
) => MemoryRecallResult | Promise<MemoryRecallResult>;

export type MemoryCaptureHandler<TContext extends MemoryOperationContext> = (
  context: TContext,
) => void | Promise<void>;

export interface MemoryToolsContext extends DynamicResolveContext {
  readonly memory: {
    readonly scope: MemoryScope;
    readonly slot: string;
  };
  readonly turn: MemoryTurnContext;
}

export interface MemoryToolDefinition {
  readonly approval?: Approval<never>;
  readonly description: string;
  readonly execution?: never;
  execute(input: never, context: ToolContext): unknown | Promise<unknown> | AsyncIterable<unknown>;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly toModelOutput?: (output: never) => ToolModelOutput | Promise<ToolModelOutput>;
}

export type MemoryToolSet = Readonly<Record<string, MemoryToolDefinition>>;

export interface MemoryProvider {
  readonly recall: {
    readonly "turn.started": MemoryRecallHandler<MemoryTurnStartedContext>;
    readonly "compaction.completed"?: MemoryRecallHandler<MemoryCompactionCompletedContext>;
  };
  readonly capture?: {
    readonly "compaction.requested"?: MemoryCaptureHandler<MemoryCompactionRequestedContext>;
    readonly "turn.completed"?: MemoryCaptureHandler<MemoryTurnCompletedContext>;
  };
  readonly tools?: (context: MemoryToolsContext) => Promise<MemoryToolSet | null>;
}

export type MemoryVisibility = "scope" | "session";

export interface MemoryDefinition {
  readonly description?: string;
  readonly namespace?: MemoryNamespaceDefinition;
  readonly provider: MemoryProvider;
  readonly scope: MemoryScopeDefinition;
  readonly visibility?: MemoryVisibility;
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
  return JSON.stringify([
    "eve-memory-default-namespace-v1",
    "vercel",
    projectId,
    environment,
    previewIdentity,
    context.node,
    context.slot,
  ]);
}
