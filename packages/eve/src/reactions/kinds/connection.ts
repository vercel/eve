import { assertNotConnectionOwned } from "#connections/ownership.js";
import type { ContextContainer } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { CONNECTION_SLUG_PATTERN } from "#discover/grammar.js";
import { eveNamespaceReservation } from "#protocol/runtime-tools.js";
import { readStampedConnectionProtocol } from "#public/definitions/connections/protocol.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import { resolveDynamicConnectionValue } from "#runtime/resolve-connection.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type {
  ResolvedConnectionDefinition,
  ResolvedDynamicConnectionResolver,
} from "#runtime/types.js";
import type { JsonObject } from "#shared/json.js";
import { authoredEvaluate, type ValueReaction } from "../reaction.js";
import { entryVersions, slotsOf } from "../state.js";
import { dynamicToolNames } from "./tool.js";

/**
 * A `defineDynamic()` in `agent/connections/`: one connection named after the file, or a map.
 * Rebuild callbacks even when the target is unchanged: the current policy can have changed.
 */
export function connectionReaction(resolver: ResolvedDynamicConnectionResolver): ValueReaction {
  return {
    contribute: (result, { ctx }) => {
      const connections = namedConnections(resolver, result).map(({ name, value }) =>
        resolveDynamicConnectionValue(value, {
          connectionName: name,
          exportName: resolver.exportName,
          logicalPath: resolver.logicalPath,
          sourceId: resolver.sourceId,
          sourceKind: "module",
        }),
      );
      assertOwnsNoEntries(ctx, connections, resolver);
      if (connections.length === 0) return { value: null };
      return { live: connections, value: connections.map(target) };
    },
    id: `connection:${resolver.extensionNamespace ?? ""}:${resolver.slug}`,
    kind: "connection",
    evaluate: authoredEvaluate(resolver.evaluate, { framework: resolver.framework }),
    label: resolver.logicalPath,
  };
}

/**
 * What a connection's slot records: its name and where it reaches, so a render that points the
 * same name somewhere else doesn't match. Equal names don't make two connections the same.
 */
function target(connection: ResolvedConnectionDefinition): JsonObject {
  const authorization = connection.authorization;
  const principalType =
    typeof authorization === "object" && authorization !== null
      ? authorization.principalType
      : undefined;
  return {
    name: connection.connectionName,
    protocol: connection.protocol,
    url: connection.url,
    ...(connection.instanceId !== undefined && { instanceId: connection.instanceId }),
    ...(principalType !== undefined && { principalType }),
  };
}

/** Installs the slots' connections in the step's registry, which starts with the static ones. */
export async function installDynamicConnections(ctx: ContextContainer): Promise<void> {
  const registry = ctx.get(ConnectionRegistryKey);
  if (!(registry instanceof ConnectionRegistryImpl)) return;
  await registry.replaceDynamicConnections(
    new Map(
      slotsOf(ctx, "connection").map(({ id, live }) => [
        id,
        (live as readonly ResolvedConnectionDefinition[] | undefined) ?? [],
      ]),
    ),
  );
}

/**
 * Every connection name the session has: the registry's, and those dynamic connections this
 * evaluation already returned, which the registry installs only after every value has run.
 */
export function sessionConnectionNames(ctx: Pick<ContextReader, "get">): readonly string[] {
  return [
    ...new Set([
      ...(ctx.get(ConnectionRegistryKey)?.getConnectionNames() ?? []),
      ...dynamicConnectionVersions(ctx).keys(),
    ]),
  ];
}

/** The version of each dynamic connection, by name: what it reaches, and its memo results. */
export function dynamicConnectionVersions(
  ctx: Pick<ContextReader, "get"> | undefined,
): ReadonlyMap<string, string> {
  const versions = new Map<string, string>();
  for (const { id, slot } of slotsOf(ctx, "connection")) {
    const versionOf = entryVersions(ctx!, id);
    for (const target of Array.isArray(slot.value) ? slot.value : []) {
      const name = (target as { readonly name?: unknown } | null)?.name;
      if (typeof name === "string" && !versions.has(name)) versions.set(name, versionOf(target));
    }
  }
  return versions;
}

function namedConnections(
  resolver: ResolvedDynamicConnectionResolver,
  value: unknown,
): readonly { readonly name: string; readonly value: unknown }[] {
  if (value === null || value === undefined) return [];
  if (readStampedConnectionProtocol(value) !== undefined) return [{ name: resolver.slug, value }];
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `The defineDynamic() in "${resolver.logicalPath}" must return a connection definition, a map of connection definitions, or null.`,
    );
  }
  const prefix =
    resolver.extensionNamespace === undefined ? "" : `${resolver.extensionNamespace}__`;
  return Object.entries(value).map(([name, entry]) => {
    if (!CONNECTION_SLUG_PATTERN.test(name)) {
      throw new Error(
        `The defineDynamic() in "${resolver.logicalPath}" returned illegal connection name "${name}". Expected lowercase ASCII letters, digits, and dashes only, starting with a letter, up to 64 characters.`,
      );
    }
    if (readStampedConnectionProtocol(entry) === undefined) {
      throw new Error(
        `The defineDynamic() in "${resolver.logicalPath}" returned "${name}" without defineMcpClientConnection() or defineOpenAPIConnection().`,
      );
    }
    return { name: `${prefix}${name}`, value: entry };
  });
}

/** No dynamic connection may take eve's names, or own a tool's or subagent's. */
function assertOwnsNoEntries(
  ctx: ContextContainer,
  connections: readonly ResolvedConnectionDefinition[],
  resolver: ResolvedDynamicConnectionResolver,
): void {
  for (const { connectionName } of connections) {
    const reservation = eveNamespaceReservation(connectionName);
    if (reservation === undefined) continue;
    throw new Error(
      `The defineDynamic() in "${resolver.logicalPath}" returned the reserved connection name "${connectionName}". ${reservation}; rename the connection.`,
    );
  }
  const bundle = ctx.get(BundleKey);
  const entryNames = [
    ...(bundle?.toolRegistry.toolsByName.keys() ?? []),
    ...(bundle?.subagentRegistry.subagentsByName.keys() ?? []),
    ...(bundle?.subagentRegistry.dynamicResolvers.map((dynamic) => dynamic.name) ?? []),
    ...dynamicToolNames(ctx),
  ];
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
