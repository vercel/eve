import { createHash } from "node:crypto";
import { installedDurableHost } from "#execution/hosts.js";
import { passesToolFilter } from "#runtime/connections/tool-filter.js";
import { createMcpTraceFetch } from "#runtime/connections/mcp-tracing.js";
import { createMcpTracing } from "#tracing/eve/mcp.js";
import { withConnectionEventSpan } from "#tracing/eve/connection-events.js";
import { principalOf } from "#execution/session/principal.js";
import { defineJsonSchema, toInputSchema } from "#tools/schema.js";
import { connectionSubscriptionId } from "#runtime/subscriptions/keys.js";
import type {
  Experimental_MCPEventDefinition as EventDefinition,
  Experimental_MCPEvents as MCPEvents,
} from "#compiled/@ai-sdk/mcp/index.js";
import { contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey, SessionTraceSeedKey } from "#context/keys.js";
import { requireCompiledBundle, SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedConnectionDefinition, ResolvedConnectionEvents } from "#runtime/types.js";
import type { ChannelEventDefinition } from "#shared/channel-subscriptions.js";
import type { ConnectionToolExecuteOptions } from "#shared/connection-types.js";
import type { ManagedEventSubscribeInput } from "#shared/connection-events.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import { SEARCH_TOOL_NAME } from "#protocol/catalog-tools.js";
import { closestNames } from "#execution/catalog/rank.js";
import { principalKey, resolveConnectionPrincipal } from "#runtime/connections/principal.js";
import { holdCallerIdentity } from "#runtime/connections/identity-hold.js";
import {
  heldByCaller,
  type ConnectionBinding,
  type ConnectionSubscriptionSource,
  type SubscriptionBinding,
} from "#runtime/subscriptions/state.js";
import type { ManagedEventSubscription } from "#shared/connection-events.js";

export const EVENT_STOP_ACTION = "events_unsubscribe";
export const EVENT_SUBSCRIBE_ACTION = "events_subscribe";
const SUBSCRIBE_PREFIX = "events_subscribe_";

export function eventFilterNames(eventName: string): string[] {
  return [
    `${SUBSCRIBE_PREFIX}${eventName}`,
    `${SUBSCRIBE_PREFIX}${createHash("sha256").update(eventName).digest("hex").slice(0, 24)}`,
  ];
}

export function toolFilterMayOfferEvents(filter: ResolvedConnectionDefinition["tools"]): boolean {
  return (
    filter === undefined ||
    !("allow" in filter) ||
    filter.allow.some((name) => name.startsWith(SUBSCRIBE_PREFIX))
  );
}
export const MIN_TTL_MS = 120_000;
export const MAX_TTL_MS = 31_536_000_000;
type EventCatalog = Pick<MCPEvents, "list">;
const SUBSCRIBE_INPUT_SCHEMA = defineJsonSchema<
  Pick<ManagedEventSubscribeInput, "arguments" | "ttlMs"> & { event: string }
>({
  type: "object",
  additionalProperties: false,
  required: ["event", "arguments", "ttlMs"],
  properties: {
    event: { type: "string" },
    arguments: { type: "object" },
    ttlMs: {
      type: ["integer", "null"],
      minimum: MIN_TTL_MS,
      maximum: MAX_TTL_MS,
    },
  },
});

export class ConnectionEventActions {
  private readonly connection: ResolvedConnectionDefinition;
  private readonly events: ResolvedConnectionEvents;
  private readonly headers: () => Promise<Record<string, string>>;
  private readonly transportFetch: typeof fetch | undefined;
  constructor(
    connection: ResolvedConnectionDefinition,
    events: ResolvedConnectionEvents,
    headers: () => Promise<Record<string, string>>,
    transportFetch?: typeof fetch,
  ) {
    this.connection = connection;
    this.events = events;
    this.headers = headers;
    this.transportFetch = transportFetch;
  }

  private scope(options?: { readonly hold?: boolean }) {
    const ctx = contextStorage.getStore();
    if (ctx === undefined) throw new Error("Event subscriptions require an active eve session.");
    if (ctx.get(SessionAgentKey)?.nodeId !== undefined)
      throw new Error(
        "Experimental event subscriptions currently require a root-agent connection.",
      );
    const { authorization, backend, connector } = this.events;
    const principal = resolveConnectionPrincipal(
      this.connection.connectionName,
      authorization,
      ctx,
    );
    if (options?.hold !== false) holdCallerIdentity(this.connection.connectionName, ctx);
    const sessionId = ctx.require(SessionIdKey);
    const owner = principalKey(principal);
    const executionPrincipal = principalOf(ctx.get(AuthKey));
    const caller: Caller = {
      connectionName: this.connection.connectionName,
      instanceId: this.connection.instanceId,
      connector,
      principalKey: owner,
      executionPrincipal,
    };
    return {
      ctx,
      principal,
      sessionId,
      owner,
      executionPrincipal,
      caller,
      backend,
      connector,
    };
  }

  private async withClient<T>(
    run: (events: EventCatalog) => Promise<T>,
    options?: { readonly hold?: boolean },
  ): Promise<T> {
    this.scope(options);
    let client: Awaited<ReturnType<typeof createMCPClient>> | undefined;
    const config = {
      transport: {
        type: "http" as const,
        fetch: createMcpTraceFetch({
          connectionName: this.connection.connectionName,
          fetcher: this.transportFetch,
          getProtocolVersion: () => client?.initializeResult?.protocolVersion,
        }),
        url: this.connection.url,
        headers: await this.headers(),
      },
      protocolVersionDiscovery: this.connection.protocolVersionDiscovery,
    };
    const { createMCPClient } = await import("#compiled/@ai-sdk/mcp/index.js");
    client = await createMCPClient(config);
    try {
      return await run(client.experimental_events);
    } finally {
      await client.close();
    }
  }

  private async catalog(events: EventCatalog): Promise<EventDefinition[]> {
    const result: EventDefinition[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let discovered = 0;
    for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
      const page = await withConnectionEventSpan(
        {
          ctx: this.scope({ hold: false }).ctx,
          connectionName: this.connection.connectionName,
          operation: "catalog",
        },
        () =>
          createMcpTracing().list({
            connectionName: this.connection.connectionName,
            method: "events/list",
            execute: () => events.list({ params: { cursor }, options: { timeout: 15_000 } }),
          }),
      );
      discovered += page.events.length;
      if (discovered > 1000) throw new Error("MCP event catalog exceeds the 1000-event limit.");
      result.push(
        ...page.events.filter(
          (event) =>
            event.delivery.includes("webhook") &&
            passesToolFilter(eventFilterNames(event.name), this.connection.tools),
        ),
      );
      cursor = page.nextCursor ?? undefined;
      if (cursor === undefined) return result;
      if (seen.has(cursor)) throw new Error("MCP event catalog returned a repeated cursor.");
      seen.add(cursor);
    }
    throw new Error("MCP event catalog exceeds the 20-page limit.");
  }

  async getEvents(): Promise<ChannelEventDefinition[]> {
    return this.withClient(
      async (events) =>
        (await this.catalog(events)).map((event) => ({
          name: event.name,
          description: event.description ?? "",
          inputSchema: defineJsonSchema(objectSchema(event.inputSchema)),
        })),
      { hold: false },
    );
  }

  async execute(
    name: string,
    input: unknown,
    options: ConnectionToolExecuteOptions,
  ): Promise<unknown> {
    const args = parseJsonObject(input);
    const { ctx, sessionId, owner, executionPrincipal, caller } = this.scope();
    const owners = installedDurableHost()?.subscriptions;
    if (owners === undefined)
      throw new Error("Subscriptions are not supported on this host. Run from a deployed agent.");
    if (name === EVENT_STOP_ACTION) {
      if (typeof args.id !== "string") throw new Error("id must be a subscription id.");
      const bindingId = args.id;
      const handler = await owners.find(bindingId);
      if (
        handler === undefined ||
        !heldBy(handler.binding, caller, sessionId) ||
        !(await owners.retire(bindingId))
      )
        throw new Error("Unknown subscription for this caller and account.");
      return { id: bindingId, status: "stopping" as const };
    }
    if (name !== EVENT_SUBSCRIBE_ACTION) throw new Error(`Unknown event action "${name}".`);
    return this.withClient(async (events) => {
      const inputResult = await SUBSCRIBE_INPUT_SCHEMA["~standard"].validate(args);
      if (inputResult.issues !== undefined)
        throw new Error(
          `Invalid subscription input: ${inputResult.issues.map(({ message }) => message).join("; ")}`,
        );
      const { event: eventName, arguments: inputArguments, ttlMs } = inputResult.value;
      const catalog = await this.catalog(events);
      const definition = catalog.find((event) => event.name === eventName);
      if (definition === undefined)
        throw new Error(
          unknownEventMessage(
            this.connection.connectionName,
            eventName,
            catalog.map((event) => ({ name: event.name, description: event.description ?? "" })),
          ),
        );
      const valid = await toInputSchema(objectSchema(definition.inputSchema))["~standard"].validate(
        parseJsonObject(inputArguments),
      );
      if (valid.issues !== undefined)
        throw new Error("Event arguments do not match the authorized catalog schema.");
      const eventArguments = parseJsonObject(valid.value);
      const id = connectionSubscriptionId({
        sessionId,
        instanceId: this.connection.instanceId,
        connectionName: this.connection.connectionName,
        owner,
        executionPrincipal,
        event: definition.name,
        arguments: eventArguments,
      });
      const binding: ConnectionBinding = {
        id,
        source: {
          kind: "connection",
          name: caller.connectionName,
          instanceId: caller.instanceId,
          connector: caller.connector,
          principalKey: caller.principalKey,
          request: {
            name: definition.name,
            arguments: structuredClone(eventArguments) as ManagedEventSubscribeInput["arguments"],
            ttlMs,
            context: { eve: { version: 1, sessionId, bindingId: id } },
          },
        },
        sessionId,
        executionPrincipal,
        auth: structuredClone(ctx.get(AuthKey) ?? null),
        traceSeed: ctx.get(SessionTraceSeedKey),
      };
      const opened = await owners.start(binding, requireCompiledBundle(ctx), options.abortSignal);
      return opened?.upstream === undefined
        ? pendingResult(binding)
        : subscriptionResult(id, opened.upstream);
    });
  }
}

function objectSchema(schema: EventDefinition["inputSchema"] | undefined): JsonObject {
  if (schema === undefined) return { type: "object" };
  return typeof schema === "boolean" ? { allOf: [schema] } : parseJsonObject(schema);
}

function unknownEventMessage(
  connectionName: string,
  event: string,
  events: readonly { readonly name: string; readonly description: string }[],
): string {
  const closest = closestNames(event, events);
  return `Connection "${connectionName}" emits no event named "${event}".${
    closest.length > 0 ? ` Closest events: ${closest.join(", ")}.` : ""
  } Find its events with ${SEARCH_TOOL_NAME}({ query: "subscriptions__${connectionName}__" }).`;
}

function subscriptionResult(bindingId: string, subscription: ManagedEventSubscription) {
  return { ...subscription, id: bindingId, subscriptionId: subscription.id };
}

function pendingResult(binding: ConnectionBinding) {
  const { name, arguments: eventArguments } = binding.source.request;
  return { id: binding.id, name, arguments: eventArguments, status: "pending" as const };
}

type Caller = Pick<ConnectionSubscriptionSource, "instanceId" | "connector" | "principalKey"> & {
  readonly connectionName: string;
  readonly executionPrincipal: string;
};

function heldBy(
  binding: SubscriptionBinding,
  caller: Caller,
  sessionId: string,
): binding is ConnectionBinding {
  const { source } = binding;
  return (
    source.kind === "connection" &&
    source.name === caller.connectionName &&
    source.instanceId === caller.instanceId &&
    source.connector === caller.connector &&
    source.principalKey === caller.principalKey &&
    heldByCaller(binding, { executionPrincipal: caller.executionPrincipal, sessionId })
  );
}
