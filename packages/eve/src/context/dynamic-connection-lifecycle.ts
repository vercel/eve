import { getAdapterKind } from "#channel/adapter.js";
import type { ContextContainer } from "#context/container.js";
import { AuthKey, InitiatorAuthKey, SessionIdKey } from "#context/keys.js";
import { assertNotConnectionOwned } from "#connections/ownership.js";
import { dynamicToolNames } from "#context/build-dynamic-tools.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import type { DynamicSessionOrTurnEvent } from "#dynamic/definition.js";
import { CONNECTION_SLUG_PATTERN } from "#discover/grammar.js";
import { createLogger } from "#internal/logging.js";
import { eveNamespaceReservation } from "#protocol/runtime-tools.js";
import { readStampedConnectionProtocol } from "#public/definitions/connections/protocol.js";
import type { DynamicConnectionResolveContext } from "#public/definitions/connections/dynamic.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { resolveDynamicConnectionValue } from "#runtime/resolve-connection.js";
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

function qualifyConnectionNames(
  resolver: ResolvedDynamicConnectionResolver,
  value: unknown,
): readonly { readonly name: string; readonly value: unknown }[] {
  if (readStampedConnectionProtocol(value) !== undefined) {
    return [{ name: resolver.slug, value }];
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Dynamic connection resolver "${resolver.logicalPath}" must return a connection definition, a map of connection definitions, or null.`,
    );
  }

  const prefix =
    resolver.extensionNamespace === undefined ? "" : `${resolver.extensionNamespace}__`;
  return Object.entries(value).map(([name, entry]) => {
    if (!CONNECTION_SLUG_PATTERN.test(name)) {
      throw new Error(
        `Dynamic connection resolver "${resolver.logicalPath}" returned illegal connection name "${name}". Expected lowercase ASCII letters, digits, and dashes only, starting with a letter, up to 64 characters.`,
      );
    }
    if (readStampedConnectionProtocol(entry) === undefined) {
      throw new Error(
        `Dynamic connection resolver "${resolver.logicalPath}" returned "${name}" without defineMcpClientConnection() or defineOpenAPIConnection().`,
      );
    }
    return { name: `${prefix}${name}`, value: entry };
  });
}

/** The scopes a connection resolver answers. */

async function resolveConnections(input: {
  readonly ctx: ContextContainer;
  readonly event: DynamicSessionOrTurnEvent;
  readonly resolver: ResolvedDynamicConnectionResolver;
}): Promise<readonly ResolvedConnectionDefinition[]> {
  const handler = input.resolver.events[input.event.type];
  if (handler === undefined) return [];
  const value = await handler(input.event, buildConnectionResolveContext(input.ctx));
  if (value === null || value === undefined) return [];

  return qualifyConnectionNames(input.resolver, value).map(({ name, value: definition }) =>
    resolveDynamicConnectionValue(definition, {
      connectionName: name,
      exportName: input.resolver.exportName,
      logicalPath: input.resolver.logicalPath,
      sourceId: input.resolver.sourceId,
      sourceKind: "module",
    }),
  );
}

/** Resolves and replaces the dynamic connection set for a session or a turn. */
export async function resolveDynamicConnections(input: {
  readonly ctx: ContextContainer;
  readonly resolvers: readonly ResolvedDynamicConnectionResolver[];
  readonly event: DynamicSessionOrTurnEvent;
}): Promise<void> {
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
      connections: await resolveConnections({ ...input, resolver }),
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
