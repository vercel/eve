import { CONNECTION_SLUG_PATTERN } from "#discover/grammar.js";
import { readStampedConnectionProtocol } from "#public/definitions/connections/protocol.js";
import type { DynamicConnectionResolveContext } from "#public/definitions/connections/dynamic.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { resolveDynamicConnectionValue } from "#runtime/resolve-connection.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type { CompiledDynamicConnectionDefinition } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { isDynamicSentinel } from "#dynamic/definition.js";
import { expectFunction, expectObjectRecord } from "#internal/authored-module.js";
import { loadResolvedModuleExport, ResolveAgentError } from "#runtime/resolve-helpers.js";
import type { ResolvedDynamicConnectionResolver } from "#runtime/types.js";
import { toErrorMessage } from "#shared/errors.js";

/** Reattaches live event handlers for one compiled dynamic connection source. */
export async function resolveDynamicConnectionDefinition(
  definition: CompiledDynamicConnectionDefinition,
  moduleMap: CompiledModuleMap,
  nodeId: string | undefined,
): Promise<ResolvedDynamicConnectionResolver> {
  try {
    const value = await loadResolvedModuleExport({
      definition,
      kindLabel: "dynamic connection",
      moduleMap,
      nodeId,
    });
    const record = expectObjectRecord(value, describe(definition, "to return an object"));
    if (!isDynamicSentinel(record)) {
      throw new Error(describe(definition, "to be created by defineDynamic()"));
    }
    const events = expectObjectRecord(
      record.events,
      describe(definition, "to provide an events object"),
    );
    const handlers: Record<string, Function> = {};
    for (const eventName of definition.eventNames) {
      handlers[eventName] = expectFunction(
        events[eventName],
        describe(definition, `to provide a handler for event "${eventName}"`),
      );
    }
    return {
      eventNames: [...definition.eventNames],
      events: handlers as ResolvedDynamicConnectionResolver["events"],
      exportName: definition.exportName,
      extensionNamespace: definition.extensionNamespace,
      logicalPath: definition.logicalPath,
      slug: definition.slug,
      sourceId: definition.sourceId,
      sourceKind: "module",
    };
  } catch (error) {
    if (error instanceof ResolveAgentError) throw error;
    throw new ResolveAgentError(
      `Failed to resolve dynamic connection from "${definition.logicalPath}": ${toErrorMessage(error)}`,
      { logicalPath: definition.logicalPath, sourceId: definition.sourceId },
    );
  }
}

function describe(definition: CompiledDynamicConnectionDefinition, predicate: string): string {
  return `Expected the dynamic connection export "${definition.exportName ?? "default"}" from "${definition.logicalPath}" ${predicate}.`;
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

export async function resolveDynamicConnectionResult(input: {
  readonly context: DynamicConnectionResolveContext;
  readonly nodeId?: string;
  readonly event: UnstampedMessageStreamEvent;
  readonly resolver: ResolvedDynamicConnectionResolver;
}): Promise<readonly ResolvedConnectionDefinition[]> {
  const handler = input.resolver.events[input.event.type];
  if (handler === undefined) return [];
  const context = structuredClone(input.context);
  const value = await handler(input.event, input.context);
  if (value === null || value === undefined) return [];

  return qualifyConnectionNames(input.resolver, value).map(({ name, value: definition }) => {
    const connection = resolveDynamicConnectionValue(definition, {
      connectionName: name,
      exportName: input.resolver.exportName,
      logicalPath: input.resolver.logicalPath,
      sourceId: input.resolver.sourceId,
      sourceKind: "module",
    });
    if (connection.experimental_events === undefined) return connection;
    if (input.nodeId !== undefined || input.event.type !== "session.started")
      throw new Error(
        "Dynamic event subscriptions require a root-agent session.started connection.",
      );
    const { sourceId, slug } = input.resolver;
    const resolution = {
      sourceId,
      slug,
      context,
      runtime: structuredClone(input.event.data.runtime),
    };
    if (Buffer.byteLength(JSON.stringify(resolution)) > 65_536)
      throw new Error("Dynamic event connection recovery context exceeds 64 KiB.");
    return {
      ...connection,
      experimental_events: { ...connection.experimental_events, resolution },
    };
  });
}
