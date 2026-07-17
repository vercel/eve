import type { ModelMessage } from "ai";

import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { ApprovalContext } from "#public/definitions/approval.js";
import type { DynamicToolEntry } from "#shared/dynamic-tool-definition.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import {
  ALLOWED_DYNAMIC_TOOL_EVENTS,
  isBrandedToolEntry,
} from "#shared/dynamic-tool-definition.js";
import type { ResolvedDynamicToolResolver } from "#runtime/types.js";
import { createLogger } from "#internal/logging.js";
import {
  serializeInputSchema,
  serializeOutputSchema,
  toInputSchema,
  toOutputSchema,
} from "#shared/tool-schema.js";
import { toErrorMessage } from "#shared/errors.js";
import { buildBaseToolContext } from "#context/build-base-tool-context.js";
import type { ContextContainer } from "#context/container.js";
import type { ContextKey } from "#context/key.js";
import {
  SessionDynamicToolMetadataKey,
  TurnDynamicToolMetadataKey,
  LiveStepToolsKey,
} from "#context/keys.js";
import type { DurableDynamicToolMetadata } from "#context/keys.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";

const log = createLogger("dynamic-tools");

// ---------------------------------------------------------------------------
// Tool entry conversion
// ---------------------------------------------------------------------------

function toHarnessToolDefinition(name: string, entry: DynamicToolEntry): HarnessToolDefinition {
  return {
    description: entry.description,
    execute: (input: unknown, options) =>
      entry.execute(
        input as Record<string, unknown>,
        buildBaseToolContext({ options, toolName: name }),
      ),
    inputSchema: toInputSchema(entry.inputSchema),
    name,
    approval: entry.approval,
    outputSchema: toOutputSchema(entry.outputSchema),
    ...(entry.toModelOutput !== undefined
      ? { toModelOutput: entry.toModelOutput as (output: unknown) => unknown }
      : {}),
  };
}

function qualifyDynamicToolNames(
  resolver: ResolvedDynamicToolResolver,
  isSingle: boolean,
  entries: Readonly<Record<string, DynamicToolEntry>>,
): Array<{ name: string; entryKey: string; entry: DynamicToolEntry }> {
  const keys = Object.keys(entries);
  const result: Array<{ name: string; entryKey: string; entry: DynamicToolEntry }> = [];

  if (keys.length === 0) return result;

  // A single returned defineTool is named after the file slug; a map names each
  // entry by its bare key (authors namespace keys themselves if needed).
  if (isSingle) {
    result.push({ name: resolver.slug, entryKey: keys[0]!, entry: entries[keys[0]!]! });
    return result;
  }

  // Map entries from an extension resolver are prefixed with the mount
  // namespace so extension-produced tools are namespaced like the extension's
  // static tools. The single-tool case above already uses the namespaced slug.
  const prefix =
    resolver.extensionNamespace !== undefined ? `${resolver.extensionNamespace}__` : "";
  for (const key of keys) {
    result.push({ name: `${prefix}${key}`, entryKey: key, entry: entries[key]! });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tool replay from durable metadata
// ---------------------------------------------------------------------------

/**
 * Reconstructs tool definitions from durable metadata using
 * registered step functions. No resolver re-invocation — the
 * execute function is looked up by step ID and called with stored
 * closure vars.
 */
export function replayDynamicSessionTools(
  metadata: readonly DurableDynamicToolMetadata[],
  _resolvers: readonly ResolvedDynamicToolResolver[],
): readonly HarnessToolDefinition[] {
  const tools: HarnessToolDefinition[] = [];

  for (const m of metadata) {
    if (!m.executeStepFnName || !m.closureVars) {
      log.warn(
        `Dynamic tool "${m.name}" has no registered step function — ` +
          "skipping on this step. The bundler transform may not have processed this tool file.",
      );
      continue;
    }

    const stepFn = lookupStepFunction(m.executeStepFnName);
    if (!stepFn) {
      log.warn(
        `Dynamic tool "${m.name}" references step function "${m.executeStepFnName}" ` +
          "which is not registered — skipping on this step.",
      );
      continue;
    }

    tools.push({
      description: m.description,
      execute: (input: unknown, options) =>
        stepFn(m.closureVars, input, buildBaseToolContext({ options, toolName: m.name })),
      inputSchema: toInputSchema(m.inputSchema),
      name: m.name,
      outputSchema: toOutputSchema(m.outputSchema),
    });
  }

  return tools;
}

// ---------------------------------------------------------------------------
// Step function lookup + serialization helpers
// ---------------------------------------------------------------------------

function getStepRegistry(): Map<string, Function> {
  const key = Symbol.for("@workflow/core//registeredSteps");
  const g = globalThis as Record<symbol, Map<string, Function> | undefined>;
  let registry = g[key];
  if (registry === undefined) {
    registry = new Map();
    g[key] = registry;
  }
  return registry;
}

function lookupStepFunction(stepId: string): ((...args: unknown[]) => unknown) | null {
  try {
    const fn = getStepRegistry().get(stepId);
    return fn ? (fn as (...args: unknown[]) => unknown) : null;
  } catch {
    return null;
  }
}

function registerStepFunction(stepId: string, fn: Function): void {
  getStepRegistry().set(stepId, fn);
}

function safeSerialize(obj: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Scoped key routing
// ---------------------------------------------------------------------------

function durableKeyForEvent(
  eventType: string,
): ContextKey<readonly DurableDynamicToolMetadata[]> | undefined {
  switch (eventType) {
    case "session.started":
      return SessionDynamicToolMetadataKey;
    case "turn.started":
      return TurnDynamicToolMetadataKey;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Build: assemble live tools from all scoped durable keys
// ---------------------------------------------------------------------------

/**
 * Builds live dynamic tool definitions from session + turn + step
 * durable metadata keys. Session-scoped tools appear first, then
 * turn, then step. The tool-loop calls this right before the model
 * call — no virtual key needed.
 */
// ---------------------------------------------------------------------------
// Resolve: run resolver handlers, capture closures, write durable metadata
// ---------------------------------------------------------------------------

interface ResolveResult {
  readonly metadata: readonly DurableDynamicToolMetadata[];
  readonly liveTools: readonly HarnessToolDefinition[];
}

async function resolveToolsFromEvent(
  ctx: ContextContainer,
  resolvers: readonly ResolvedDynamicToolResolver[],
  event: HandleMessageStreamEvent,
  messages: readonly ModelMessage[],
): Promise<ResolveResult> {
  const outcomes = await Promise.allSettled(
    resolvers.map(async (resolver) => {
      const handler = resolver.events[event.type];
      if (handler === undefined) return null;

      const resolveCtx = buildResolveContext(ctx, messages);
      const rawResult = await handler(event, resolveCtx);
      if (rawResult === null || rawResult === undefined) return null;

      let entries: Record<string, DynamicToolEntry>;
      let isSingle: boolean;
      if (isBrandedToolEntry(rawResult)) {
        entries = { _single: rawResult as DynamicToolEntry };
        isSingle = true;
      } else {
        entries = rawResult as Record<string, DynamicToolEntry>;
        isSingle = false;
      }

      return { resolver, entries, isSingle };
    }),
  );

  const metadata: DurableDynamicToolMetadata[] = [];
  const liveTools: HarnessToolDefinition[] = [];
  // Tracks which resolver claimed each name so two dynamic resolvers can't
  // silently shadow each other (a dynamic tool overriding an authored one is
  // allowed and handled at merge time).
  const dynamicToolOwners = new Map<string, string>();

  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      log.error(`Dynamic tool resolver (${event.type}) threw — skipping.`, {
        error: toErrorMessage(outcome.reason),
      });
      continue;
    }
    if (outcome.value === null) continue;

    const { resolver, entries, isSingle } = outcome.value;
    const named = qualifyDynamicToolNames(resolver, isSingle, entries);
    for (const { name, entryKey, entry } of named) {
      const previousOwner = dynamicToolOwners.get(name);
      if (previousOwner !== undefined && previousOwner !== resolver.slug) {
        throw new Error(
          `Dynamic tool "${name}" from resolver "${resolver.slug}" collides with dynamic resolver "${previousOwner}". Namespace the map key manually, e.g. "${resolver.slug}__${name}".`,
        );
      }
      dynamicToolOwners.set(name, resolver.slug);

      liveTools.push(toHarnessToolDefinition(name, entry));
      if (event.type === "step.started") {
        continue;
      }

      const stepFn =
        "__executeStepFn" in entry
          ? (entry as { __executeStepFn?: { stepId?: string } }).__executeStepFn
          : undefined;
      const closureVars =
        "__closureVars" in entry
          ? (entry as { __closureVars?: Record<string, unknown> }).__closureVars
          : undefined;

      let executeStepFnName = stepFn?.stepId;
      let serializedClosureVars =
        closureVars !== undefined ? safeSerialize(closureVars) : undefined;

      // Framework tools skip the bundler AST transform, so they carry
      // no __executeStepFn/__closureVars. Register the live execute
      // closure in the step registry so session/turn-scoped metadata
      // can replay them the same way as authored tools.
      if (executeStepFnName === undefined) {
        const syntheticId = `eve:framework-dynamic:${resolver.slug}:${entryKey}`;
        const originalExecute = entry.execute.bind(entry);
        registerStepFunction(syntheticId, (_closureVars: unknown, input: unknown, ctx: unknown) =>
          originalExecute(
            input as Record<string, unknown>,
            ctx as Parameters<typeof entry.execute>[1],
          ),
        );
        executeStepFnName = syntheticId;
        serializedClosureVars = {};
      }

      let approvalStepFnName: string | undefined;
      if (entry.approval !== undefined) {
        approvalStepFnName = `eve:dynamic-tool-approval:${resolver.slug}:${entryKey}`;
        const originalApproval = entry.approval.bind(entry);
        registerStepFunction(approvalStepFnName, (_closureVars: unknown, approvalCtx: unknown) =>
          originalApproval(approvalCtx as ApprovalContext),
        );
      }

      metadata.push({
        name,
        description: entry.description,
        inputSchema: serializeInputSchema(entry.inputSchema),
        outputSchema: serializeOutputSchema(entry.outputSchema),
        resolverSlug: resolver.slug,
        entryKey,
        executeStepFnName,
        approvalStepFnName,
        closureVars: serializedClosureVars,
      });
    }
  }

  return { metadata, liveTools };
}

// ---------------------------------------------------------------------------
// Dispatch: route to the scope-appropriate durable key
// ---------------------------------------------------------------------------

/**
 * Dispatches a stream event to dynamic tool resolvers. Each
 * resolver's metadata replaces its slot (by slug) in the
 * scope-appropriate durable key. The tool-loop calls
 * {@link buildDynamicTools} to assemble the effective toolset.
 */
export async function dispatchDynamicToolEvent(input: {
  readonly ctx: ContextContainer;
  readonly resolvers: readonly ResolvedDynamicToolResolver[];
  readonly event: HandleMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
}): Promise<void> {
  const { ctx, resolvers, event, messages } = input;

  if (!ALLOWED_DYNAMIC_TOOL_EVENTS.has(event.type)) return;

  const matching = resolvers.filter((r) => r.eventNames.includes(event.type));
  if (matching.length === 0) return;

  const { metadata, liveTools } = await resolveToolsFromEvent(ctx, matching, event, messages);

  // Step-scoped tools store live definitions (with original execute
  // closures) since they re-resolve every step and don't need
  // cross-step replay from durable metadata.
  if (event.type === "step.started") {
    ctx.setVirtualContext(LiveStepToolsKey, liveTools);
    return;
  }

  // Session/turn: store durable metadata for cross-step replay via
  // the bundler's registered step functions.
  const durableKey = durableKeyForEvent(event.type);
  if (durableKey === undefined) return;

  const slugs = new Set(matching.map((r) => r.slug));
  const existing = ctx.get(durableKey) ?? [];
  const kept = existing.filter((m) => !slugs.has(m.resolverSlug));
  ctx.set(durableKey, [...kept, ...metadata]);
}
