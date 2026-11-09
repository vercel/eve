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
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedConnectionDefinition, ResolvedConnectionEvents } from "#runtime/types.js";
import type {
  ConnectionToolExecuteOptions,
  ConnectionToolMetadata,
} from "#shared/connection-types.js";
import type { ManagedEventSubscribeInput } from "#shared/connection-events.js";
import { parseJsonObject } from "#shared/json.js";
import { principalKey, resolveConnectionPrincipal } from "#runtime/connections/principal.js";
import { connectionEventDestination } from "#runtime/connections/events/path.js";
import {
  sameEventOwner,
  type EventBinding,
  type EventOwner,
} from "#runtime/connections/events/state.js";
import type { ManagedEventSubscription } from "#shared/connection-events.js";

const GET = "events_get_subscription";
const STOP = "events_unsubscribe";
const PREFIX = "events_subscribe_";
const MIN_TTL_MS = 120_000;
/** The longest finite watch Connect accepts, in milliseconds. */
const MAX_TTL_MS = 31_536_000_000;
type EventCatalog = Pick<MCPEvents, "list">;
const SUBSCRIBE_INPUT_SCHEMA = defineJsonSchema<
  Pick<ManagedEventSubscribeInput, "arguments" | "ttlMs">
>(parseJsonObject(subscribeInputSchema()));

export function isEventAction(name: string): boolean {
  return name === GET || name === STOP || name.startsWith(PREFIX);
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
    if (ctx.get(BundleKey)?.nodeId !== undefined)
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
    const caller: EventOwner = {
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
    // A fresh authenticated transport keeps catalogs isolated between people sharing a session.
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
      return [
        ...catalog.map((event) => ({
          name: actionName(event.name),
          description: `Watch ${event.name}. ${event.description ?? ""} Events reach this connection's authored callback for ttlMs milliseconds or until stopped. Set ttlMs to null to watch indefinitely. Watching the same event with the same arguments again returns the existing watch.`,
          inputSchema: subscribeInputSchema(event.inputSchema),
        })),
        ...managementMetadata(),
      ];
    });
  }

  /** Existing watches must remain stoppable when upstream discovery fails. */
  recoveryMetadata(): ConnectionToolMetadata[] {
    this.scope();
    return managementMetadata().map((tool) => ({
      ...tool,
      description: `MCP discovery is unavailable. ${tool.description}`,
    }));
  }

  async execute(
    name: string,
    input: unknown,
    options: ConnectionToolExecuteOptions,
  ): Promise<unknown> {
    const args = parseJsonObject(input);
    const { ctx, principal, backend, sessionId, owner, executionPrincipal, caller } = this.scope();
    // Discovery also runs in the harness. Load the workflow runtime only when executing an action.
    const { findConnectionEventOwner, startConnectionEventOwner, retireConnectionEventOwner } =
      await import("#runtime/connections/events/owner.js");
    if (name === GET || name === STOP) {
      if (typeof args.id !== "string") throw new Error("id must be a subscription id.");
      const bindingId = args.id;
      const handler = await findConnectionEventOwner(bindingId);
      if (handler === undefined || !sameEventOwner(handler.owner, caller))
        throw new Error("Unknown subscription for this caller and account.");
      // The watch's run unsubscribes, and repeats it until Connect finishes cleaning up.
      if (name === STOP) {
        if (!(await retireConnectionEventOwner(bindingId)))
          throw new Error("Unknown subscription for this caller and account.");
        return { id: bindingId, status: "stopping" as const };
      }
      if (handler.subscription === undefined) return pendingResult(handler.owner);
      const subscriptionId = handler.subscription.id;
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
        (event) => actionName(event.name) === name,
      );
      if (definition === undefined)
        throw new Error("Unknown event subscription action for this account.");
      // Unsupported provider schemas can pass through validation. Keep eve's input checks
      // independent, and validate provider arguments with their original local $ref root.
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
      // The id names what is watched, not the tool call, so asking again after a
      // cancelled or timed-out call reaches the same watch and its subscription.
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
      const binding: EventBinding = {
        ...caller,
        id,
        sessionId,
        auth: structuredClone(ctx.get(AuthKey) ?? null),
        traceSeed: ctx.get(SessionTraceSeedKey),
        request: {
          name: definition.name,
          arguments: structuredClone(eventArguments) as ManagedEventSubscribeInput["arguments"],
          ttlMs,
          context: { eve: { version: 1, sessionId, bindingId: id } },
        },
      };
      // A watch already running under this id answers instead of a new one.
      const subscription = await startConnectionEventOwner(
        binding,
        ctx.require(BundleKey),
        options.abortSignal,
      );
      return subscription === undefined
        ? pendingResult(binding)
        : subscriptionResult(id, subscription);
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
        description: `How long to watch, in milliseconds (${MIN_TTL_MS} to ${MAX_TTL_MS}), or null until stopped`,
      },
    },
  };
}

/** Model-facing ids are eve's binding ids: they locate the handler that owns the watch. */
function subscriptionResult(bindingId: string, subscription: ManagedEventSubscription) {
  return { ...subscription, id: bindingId, subscriptionId: subscription.id };
}

/** A watch whose subscribe is still in flight: its id already works with get and stop. */
function pendingResult(binding: EventBinding) {
  const { name, arguments: eventArguments } = binding.request;
  return { id: binding.id, name, arguments: eventArguments, status: "pending" as const };
}

/** JSON with object keys sorted, so equal arguments hash equally. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => (left < right ? -1 : 1)))
      : entry,
  );
}

function actionName(eventName: string): string {
  return `${PREFIX}${createHash("sha256").update(eventName).digest("hex").slice(0, 24)}`;
}

function managementMetadata(): ConnectionToolMetadata[] {
  return [GET, STOP].map((name) => ({
    name,
    description:
      name === GET
        ? "Get one of this caller's subscriptions, by the id its subscribe call returned, with Connect's current status."
        : "Stop one of this caller's subscriptions, by the id its subscribe call returned. The watch then cancels upstream and ends; get reports it until it has.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  }));
}
