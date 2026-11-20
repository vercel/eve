import { installedDurableHost } from "#execution/hosts.js";
import { createMcpTraceFetch } from "#runtime/connections/mcp-tracing.js";
import { createMcpTracing } from "#tracing/eve/mcp.js";
import { withConnectionEventSpan } from "#tracing/eve/connection-events.js";
import { principalOf } from "#execution/session/principal.js";
import { defineJsonSchema, toInputSchema } from "#tools/schema.js";
import { createHash } from "node:crypto";
import {
  createMCPClient,
  type Experimental_MCPEventDefinition as EventDefinition,
  type Experimental_MCPEvents as MCPEvents,
} from "#compiled/@ai-sdk/mcp/index.js";
import { contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey, SessionTraceSeedKey } from "#context/keys.js";
import { requireCompiledBundle, SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedConnectionDefinition, ResolvedConnectionEvents } from "#runtime/types.js";
import type {
  ConnectionToolExecuteOptions,
  ConnectionToolMetadata,
} from "#shared/connection-types.js";
import type { ManagedEventSubscribeInput } from "#shared/connection-events.js";
import { parseJsonObject } from "#shared/json.js";
import { principalKey, resolveConnectionPrincipal } from "#runtime/connections/principal.js";
import { connectionEventDestination } from "#runtime/subscriptions/path.js";
import type {
  ConnectionBinding,
  ConnectionSubscriptionSource,
  SubscriptionBinding,
} from "#runtime/subscriptions/state.js";
import type { ManagedEventSubscription } from "#shared/connection-events.js";

export const EVENT_GET_ACTION = "events_get_subscription";
export const EVENT_STOP_ACTION = "events_unsubscribe";
const PREFIX = "events_subscribe_";
export const MIN_TTL_MS = 120_000;
export const MAX_TTL_MS = 31_536_000_000;
type EventCatalog = Pick<MCPEvents, "list">;
const SUBSCRIBE_INPUT_SCHEMA = defineJsonSchema<
  Pick<ManagedEventSubscribeInput, "arguments" | "ttlMs">
>(parseJsonObject(subscribeInputSchema()));

export function isEventAction(name: string): boolean {
  return name === EVENT_GET_ACTION || name === EVENT_STOP_ACTION || name.startsWith(PREFIX);
}

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

  private scope() {
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

  private async withClient<T>(run: (events: EventCatalog) => Promise<T>): Promise<T> {
    this.scope();
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
          ctx: this.scope().ctx,
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
      result.push(...page.events.filter((event) => event.delivery.includes("webhook")));
      cursor = page.nextCursor ?? undefined;
      if (cursor === undefined) return result;
      if (seen.has(cursor)) throw new Error("MCP event catalog returned a repeated cursor.");
      seen.add(cursor);
    }
    throw new Error("MCP event catalog exceeds the 20-page limit.");
  }

  async metadata(): Promise<ConnectionToolMetadata[]> {
    return this.withClient(async (events) => {
      const catalog = await this.catalog(events);
      return catalog.map((event) => ({
        name: eventActionName(event.name),
        event: event.name,
        description: `Subscribe to ${event.name}.${event.description ? ` ${event.description}` : ""} Events are delivered to this connection's callback for ttlMs milliseconds, or until stopped when ttlMs is null. Subscribing again with the same event and arguments returns the existing subscription.`,
        inputSchema: subscribeInputSchema(event.inputSchema),
      }));
    });
  }

  async execute(
    name: string,
    input: unknown,
    options: ConnectionToolExecuteOptions,
  ): Promise<unknown> {
    const args = parseJsonObject(input);
    const { ctx, principal, backend, sessionId, owner, executionPrincipal, caller } = this.scope();
    const owners = installedDurableHost()?.subscriptions;
    if (owners === undefined)
      throw new Error("Subscriptions are not supported on this host. Run from a deployed agent.");
    if (name === EVENT_GET_ACTION || name === EVENT_STOP_ACTION) {
      if (typeof args.id !== "string") throw new Error("id must be a subscription id.");
      const bindingId = args.id;
      const handler = await owners.find(bindingId);
      if (handler === undefined || !heldBy(handler.binding, caller))
        throw new Error("Unknown subscription for this caller and account.");
      if (name === EVENT_STOP_ACTION) {
        if (!(await owners.retire(bindingId)))
          throw new Error("Unknown subscription for this caller and account.");
        return { id: bindingId, status: "stopping" as const };
      }
      if (handler.opened === undefined) return pendingResult(handler.binding);
      const subscriptionId = handler.opened.key;
      const events = await backend.createAdapter({
        principal,
        connection: { url: this.connection.url },
        destination: { path: connectionEventDestination(this.connection.connectionName) },
      });
      const subscription = await withConnectionEventSpan(
        {
          ctx,
          connectionName: this.connection.connectionName,
          bindingId,
          subscriptionId,
          operation: "get",
        },
        () => events.getSubscription({ id: subscriptionId, options: { timeout: 30_000 } }),
      );
      return subscriptionResult(bindingId, subscription);
    }
    return this.withClient(async (events) => {
      const definition = (await this.catalog(events)).find(
        (event) => eventActionName(event.name) === name,
      );
      if (definition === undefined)
        throw new Error("Unknown event subscription action for this account.");
      const inputResult = await SUBSCRIBE_INPUT_SCHEMA["~standard"].validate(args);
      if (inputResult.issues !== undefined)
        throw new Error(
          `Invalid subscription input: ${inputResult.issues.map(({ message }) => message).join("; ")}`,
        );
      const { arguments: inputArguments, ttlMs } = inputResult.value;
      const schema =
        typeof definition.inputSchema === "boolean"
          ? { allOf: [definition.inputSchema] }
          : definition.inputSchema;
      const valid = await toInputSchema(schema)["~standard"].validate(
        parseJsonObject(inputArguments),
      );
      if (valid.issues !== undefined)
        throw new Error("Event arguments do not match the authorized catalog schema.");
      const eventArguments = parseJsonObject(valid.value);
      const id = createHash("sha256")
        .update(
          canonicalJson([
            sessionId,
            this.connection.instanceId,
            this.connection.connectionName,
            owner,
            executionPrincipal,
            definition.name,
            eventArguments,
          ]),
        )
        .digest("hex");
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

function subscribeInputSchema(
  argumentsSchema: EventDefinition["inputSchema"] = { type: "object" },
) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["arguments", "ttlMs"],
    properties: {
      arguments: argumentsSchema,
      ttlMs: {
        type: ["integer", "null"],
        minimum: MIN_TTL_MS,
        maximum: MAX_TTL_MS,
        description: `How long to keep the subscription active, in milliseconds (${MIN_TTL_MS} for 2 minutes up to ${MAX_TTL_MS} for 365 days), or null until stopped.`,
      },
    },
  };
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

function heldBy(binding: SubscriptionBinding, caller: Caller): binding is ConnectionBinding {
  const { source } = binding;
  return (
    source.kind === "connection" &&
    source.name === caller.connectionName &&
    source.instanceId === caller.instanceId &&
    source.connector === caller.connector &&
    source.principalKey === caller.principalKey &&
    binding.executionPrincipal === caller.executionPrincipal
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => (left < right ? -1 : 1)))
      : entry,
  );
}

/** The name of the generated tool that subscribes to one MCP event. */
export function eventActionName(eventName: string): string {
  return `${PREFIX}${createHash("sha256").update(eventName).digest("hex").slice(0, 24)}`;
}
