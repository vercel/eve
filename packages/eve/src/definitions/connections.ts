import { assertNotConnectionOwned } from "#connections/ownership.js";
import type { ContextContainer } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { CONNECTION_SLUG_PATTERN } from "#shared/name-grammar.js";
import { readStampedConnectionProtocol } from "#public/definitions/connections/protocol.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import { resolveDynamicConnectionValue } from "#runtime/resolve-connection.js";
import { compiledBundleOf } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedConnectionDefinition, ResolvedDynamicDefinition } from "#runtime/types.js";
import type { JsonObject } from "#shared/json.js";
import { entryVersions, slotsOf } from "#definitions/state.js";
import { namedEntries, type EntryKind } from "./named.js";
import { authoredEvaluate, type Definition } from "./definition.js";
import { dynamicToolNames } from "./tools.js";

export const connections: Definition = {
  contribute: ({ container }) => ({
    arrange: (draft) => ({
      tools: async () => {
        const tools = await draft.tools();
        await installDynamicConnections(container);
        return {
          ...tools,
          connections: container.get(ConnectionRegistryKey)?.getConnections() ?? [],
        };
      },
    }),
  }),
  id: "eve.connections",
  install: installDynamicConnections,
  label: "the agent's connections",
};

export function connectionDefinition(
  resolver: ResolvedDynamicDefinition<"connection">,
): Definition {
  const evaluate = authoredEvaluate(resolver.evaluate);
  return {
    contribute: (ctx) => ({
      tools: async () => {
        await ctx.keep(async (evaluation) => {
          const resolved = namedEntries(resolver, await evaluate(evaluation), CONNECTIONS).map(
            ({ entry: value, name }) =>
              resolveDynamicConnectionValue(value, {
                connectionName: name,
                exportName: resolver.exportName,
                logicalPath: resolver.logicalPath,
                sourceId: resolver.sourceId,
                sourceKind: "module",
              }),
          );
          assertOwnsNoEntries(evaluation.ctx, resolved, resolver);
          if (resolved.length === 0) return null;
          return { live: resolved, value: resolved.map(target) };
        });
        return {};
      },
    }),
    id: `connection:${resolver.extensionNamespace ?? ""}:${resolver.slug}`,
    label: resolver.logicalPath,
  };
}

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

export async function installDynamicConnections(ctx: Pick<ContextReader, "get">): Promise<void> {
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

export function sessionConnectionNames(ctx: Pick<ContextReader, "get">): readonly string[] {
  const registry = ctx.get(ConnectionRegistryKey);
  const own =
    registry instanceof ConnectionRegistryImpl
      ? registry.getStaticConnectionNames()
      : (registry?.getConnectionNames() ?? []);
  return [...new Set([...own, ...dynamicConnectionVersions(ctx).keys()])];
}

export function dynamicConnectionVersions(
  ctx: Pick<ContextReader, "get">,
): ReadonlyMap<string, string> {
  const versions = new Map<string, string>();
  for (const { id, slot } of slotsOf(ctx, "connection")) {
    const versionOf = entryVersions(ctx, id);
    for (const target of Array.isArray(slot.value) ? slot.value : []) {
      const name = (target as { readonly name?: unknown } | null)?.name;
      if (typeof name === "string" && !versions.has(name)) versions.set(name, versionOf(target));
    }
  }
  return versions;
}

const CONNECTIONS: EntryKind = {
  is: (value) => readStampedConnectionProtocol(value) !== undefined,
  made: "defineMcpClientConnection() or defineOpenAPIConnection()",
  noun: "connection",
  pattern: CONNECTION_SLUG_PATTERN,
  rule: "Expected lowercase ASCII letters, digits, and dashes only, starting with a letter, up to 64 characters.",
};

function assertOwnsNoEntries(
  ctx: ContextContainer,
  connections: readonly ResolvedConnectionDefinition[],
  resolver: ResolvedDynamicDefinition<"connection">,
): void {
  const bundle = compiledBundleOf(ctx);
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
