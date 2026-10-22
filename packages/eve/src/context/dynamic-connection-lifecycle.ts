import { getAdapterKind } from "#channel/adapter.js";
import type { ContextContainer } from "#context/container.js";
import { AuthKey, InitiatorAuthKey, SessionIdKey } from "#context/keys.js";
import { assertNotConnectionOwned } from "#connections/ownership.js";
import { dynamicToolNames } from "#context/build-dynamic-tools.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { ALLOWED_DYNAMIC_CONNECTION_EVENTS } from "#dynamic/definition.js";
import { createLogger } from "#internal/logging.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { eveNamespaceReservation } from "#protocol/runtime-tools.js";
import type { DynamicConnectionResolveContext } from "#public/definitions/connections/dynamic.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { resolveDynamicConnectionResult } from "#runtime/resolve-dynamic-connection.js";
import type {
  ResolvedConnectionDefinition,
  ResolvedDynamicConnectionResolver,
} from "#runtime/types.js";
import { toErrorMessage } from "#shared/errors.js";

const log = createLogger("dynamic-connections");
const DYNAMIC_CONNECTION_RESOLUTION_ERROR_CODE = "EVE_DYNAMIC_CONNECTION_RESOLUTION_FAILED";

export class DynamicConnectionResolutionError extends Error {
  readonly code = DYNAMIC_CONNECTION_RESOLUTION_ERROR_CODE;
  override readonly name = "DynamicConnectionResolutionError";

  constructor(error: unknown) {
    super(toErrorMessage(error), { cause: error });
  }
}

export function isDynamicConnectionResolutionError(
  error: unknown,
): error is DynamicConnectionResolutionError {
  return (
    error instanceof DynamicConnectionResolutionError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { readonly code?: unknown }).code === DYNAMIC_CONNECTION_RESOLUTION_ERROR_CODE)
  );
}

/** Resolves and replaces the dynamic connection set for one lifecycle scope. */
export async function dispatchDynamicConnectionEvent(input: {
  readonly ctx: ContextContainer;
  readonly resolvers: readonly ResolvedDynamicConnectionResolver[];
  readonly event: UnstampedMessageStreamEvent;
}): Promise<void> {
  if (!ALLOWED_DYNAMIC_CONNECTION_EVENTS.has(input.event.type)) return;
  const matching = input.resolvers.filter((resolver) =>
    resolver.eventNames.includes(input.event.type),
  );
  if (matching.length === 0) return;

  const registry = input.ctx.get(ConnectionRegistryKey);
  if (!(registry instanceof ConnectionRegistryImpl)) {
    throw new Error("Dynamic connection resolution requires the framework connection registry.");
  }

  const outcomes = await Promise.allSettled(
    matching.map(async (resolver) => ({
      connections: await resolveDynamicConnectionResult({
        resolver,
        event: input.event,
        context: buildConnectionResolveContext(input.ctx),
        nodeId: input.ctx.get(BundleKey)?.nodeId,
      }),
      resolver,
    })),
  );
  const updates = new Map<string, readonly ResolvedConnectionDefinition[]>();
  const entryNames = agentEntryNames(input.ctx);
  let failedResolver: ResolvedDynamicConnectionResolver | undefined;
  let failedReason: unknown;
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index]!;
    const resolver = matching[index]!;
    if (outcome.status === "rejected") {
      log.error(`Dynamic connection resolver (${input.event.type}) failed.`, {
        error: toErrorMessage(outcome.reason),
        logicalPath: resolver.logicalPath,
      });
      if (failedResolver === undefined) {
        failedResolver = resolver;
        failedReason = outcome.reason;
      }
      continue;
    }
    assertNoReservedNames(outcome.value.connections, resolver);
    assertOwnsNoEntries(outcome.value.connections, resolver, entryNames);
    updates.set(outcome.value.resolver.slug, outcome.value.connections);
  }
  if (failedResolver !== undefined) {
    throw new DynamicConnectionResolutionError(
      new Error(
        `Dynamic connection resolver "${failedResolver.logicalPath}" failed during "${input.event.type}".`,
        { cause: failedReason },
      ),
    );
  }

  await registry.replaceDynamicConnections(
    input.event.type === "session.started" ? "session" : "turn",
    updates,
  );
}

/**
 * The agent's tool and subagent names, which no connection may own. A dynamic
 * subagent's name counts whether or not its resolver has resolved yet.
 */
function agentEntryNames(ctx: ContextContainer): readonly string[] {
  const bundle = ctx.get(BundleKey);
  return [
    ...(bundle?.toolRegistry.toolsByName.keys() ?? []),
    ...(bundle?.subagentRegistry.subagentsByName.keys() ?? []),
    ...(bundle?.subagentRegistry.dynamicResolvers.map((resolver) => resolver.name) ?? []),
    ...dynamicToolNames(ctx),
  ];
}

function assertNoReservedNames(
  connections: readonly ResolvedConnectionDefinition[],
  resolver: ResolvedDynamicConnectionResolver,
): void {
  for (const { connectionName } of connections) {
    const reservation = eveNamespaceReservation(connectionName);
    if (reservation === undefined) continue;
    throw new Error(
      `Dynamic connection resolver "${resolver.logicalPath}" returned the reserved connection name "${connectionName}". ${reservation}; rename the connection.`,
    );
  }
}

function assertOwnsNoEntries(
  connections: readonly ResolvedConnectionDefinition[],
  resolver: ResolvedDynamicConnectionResolver,
  entryNames: readonly string[],
): void {
  const connectionNames = connections.map((connection) => connection.connectionName);
  for (const name of entryNames) {
    assertNotConnectionOwned({
      connectionNames,
      name,
      remedy: `Rename it, or the dynamic connection that "${resolver.logicalPath}" returned.`,
      subject: "Tool or subagent",
    });
  }
}

function buildConnectionResolveContext(ctx: ContextContainer): DynamicConnectionResolveContext {
  const channel = ctx.get(ChannelKey);
  return {
    session: {
      id: ctx.get(SessionIdKey) ?? "",
      auth: {
        current: ctx.get(AuthKey) ?? null,
        initiator: ctx.get(InitiatorAuthKey) ?? null,
      },
    },
    channel: {
      kind: channel === undefined ? undefined : getAdapterKind(channel),
    },
  };
}
