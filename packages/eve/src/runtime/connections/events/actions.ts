import { principalOf } from "#execution/session/principal.js";
import { z } from "zod";
import { toInputSchema } from "#tools/schema.js";
import { createHash } from "node:crypto";
import { createMCPClient } from "#compiled/@ai-sdk/mcp/index.js";
import { contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type {
  ConnectionToolExecuteOptions,
  ConnectionToolMetadata,
} from "#shared/connection-types.js";
import type {
  ConnectionEventsAdapter,
  ManagedEventSubscribeInput,
} from "#shared/connection-events.js";
import { parseJsonObject } from "#shared/json.js";
import { principalKey, resolveConnectionPrincipal } from "#runtime/connections/principal.js";
import { connectionEventDestination } from "#runtime/connections/events/path.js";
import {
  ConnectionEventsStateKey,
  type ConnectionEventsState,
  type EventBinding,
} from "#runtime/connections/events/state.js";

type EventDefinition = {
  name: string;
  description?: string | null;
  delivery: string[];
  inputSchema: boolean | Record<string, unknown>;
};
// Removed when the merged managed-events release can be selected in the catalog.
// This structural boundary keeps the public eve contract independent of SDK types.
interface ManagedEvents extends ConnectionEventsAdapter {
  list(input?: {
    params?: { cursor?: string };
    options?: { timeout?: number };
  }): Promise<{ events: EventDefinition[]; nextCursor?: string | null }>;
}
const LIST = "events_list_subscriptions";
const GET = "events_get_subscription";
const STOP = "events_unsubscribe";
const PREFIX = "events_subscribe_";
const MAX_BINDINGS = 100;

export function isEventAction(name: string): boolean {
  return name === LIST || name === GET || name === STOP || name.startsWith(PREFIX);
}

export class ConnectionEventActions {
  private readonly connection: ResolvedConnectionDefinition;
  private readonly headers: () => Promise<Record<string, string>>;
  private readonly transportFetch: typeof fetch | undefined;
  constructor(
    connection: ResolvedConnectionDefinition,
    headers: () => Promise<Record<string, string>>,
    transportFetch?: typeof fetch,
  ) {
    this.connection = connection;
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
    const authorization = this.connection.authorization;
    if (
      authorization === undefined ||
      typeof authorization === "function" ||
      authorization.vercelConnect?.experimental_events === undefined
    ) {
      throw new Error("Event subscriptions require a static Connect events provider.");
    }
    const principal = resolveConnectionPrincipal(
      this.connection.connectionName,
      authorization,
      ctx,
    );
    return {
      ctx,
      principal,
      authorization,
      backend: authorization.vercelConnect.experimental_events,
      connector: authorization.vercelConnect.connector,
    };
  }

  private async withClient<T>(run: (events: ManagedEvents) => Promise<T>): Promise<T> {
    const { backend, principal } = this.scope();
    const adapter = await backend.createAdapter({
      principal,
      connection: { url: this.connection.url },
      destination: { path: connectionEventDestination(this.connection.connectionName) },
    });
    // A fresh authenticated transport keeps catalogs isolated between people sharing a session.
    const config = {
      transport: {
        type: "http" as const,
        fetch: this.transportFetch,
        url: this.connection.url,
        headers: await this.headers(),
      },
      protocolVersionDiscovery: this.connection.protocolVersionDiscovery,
      experimental_events: { adapter },
    };
    const client = await createMCPClient(config);
    try {
      const events = (client as typeof client & { experimental_events?: ManagedEvents })
        .experimental_events;
      if (events === undefined || typeof events.listSubscriptions !== "function") {
        throw new Error("Managed events require the AI SDK release containing vercel/ai#22250.");
      }
      return await run(events);
    } finally {
      await client.close();
    }
  }

  private async catalog(events: ManagedEvents): Promise<EventDefinition[]> {
    const result: EventDefinition[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let discovered = 0;
    for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
      const page = await events.list({ params: { cursor }, options: { timeout: 15_000 } });
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
          description: `Watch ${event.name}. ${event.description ?? ""} Events reach this connection's authored callback; expiresAt=null watches until stopped.`,
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["arguments", "expiresAt"],
            properties: {
              arguments: event.inputSchema,
              expiresAt: {
                type: ["string", "null"],
                description: "ISO deadline, or null until stopped",
              },
            },
          },
        })),
        {
          name: LIST,
          description: "List this caller's event subscriptions created in this session.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        ...[GET, STOP].map((name) => ({
          name,
          description:
            name === GET
              ? "Get one of this caller's subscriptions in this session."
              : "Stop one of this caller's subscriptions in this session.",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
        })),
      ];
    });
  }

  async execute(
    name: string,
    input: unknown,
    options: ConnectionToolExecuteOptions,
  ): Promise<unknown> {
    const args = parseJsonObject(input);
    const { ctx, principal, connector, backend } = this.scope();
    const sessionId = ctx.require(SessionIdKey);
    const owner = principalKey(principal);
    const executionPrincipal = principalOf(ctx.get(AuthKey));
    const currentState = () =>
      ctx.ensure(ConnectionEventsStateKey, (): ConnectionEventsState => ({
        bindings: {},
        receipts: {},
      }));
    const owned = (binding: EventBinding) =>
      binding.sessionId === sessionId &&
      binding.connectionName === this.connection.connectionName &&
      binding.instanceId === this.connection.instanceId &&
      binding.connector === connector &&
      binding.principalKey === owner &&
      binding.executionPrincipal === executionPrincipal;
    const save = (binding: EventBinding) =>
      ctx.set(ConnectionEventsStateKey, (state) => ({
        receipts: state?.receipts ?? {},
        bindings: { ...state?.bindings, [binding.id]: binding },
      }));
    if (name === LIST)
      return {
        subscriptions: Object.values(currentState().bindings)
          .filter(owned)
          .map(
            (binding) =>
              binding.subscription ?? {
                id: binding.id,
                name: binding.request.name,
                status: "pending",
              },
          ),
      };
    if (name === GET || name === STOP) {
      let binding = Object.values(currentState().bindings).find(
        (binding) =>
          owned(binding) && (binding.subscription?.id === args.id || binding.id === args.id),
      );
      if (binding === undefined)
        throw new Error("Unknown subscription for this session and account.");
      if (name === STOP) save({ ...binding, retired: true });
      const events = await backend.createAdapter({
        principal,
        connection: { url: this.connection.url },
        destination: { path: connectionEventDestination(this.connection.connectionName) },
      });
      if (binding.subscription === undefined) {
        const subscription = await events.subscribe({
          ...binding.request,
          options: { timeout: 30_000 },
        });
        binding = {
          ...binding,
          subscription,
          retired: name === STOP ? true : binding.retired,
        };
        save(binding);
      }
      const subscription = await (name === STOP
        ? events.unsubscribe({ id: binding.subscription!.id, options: { timeout: 30_000 } })
        : events.getSubscription({ id: binding.subscription!.id, options: { timeout: 30_000 } }));
      save({ ...binding, retired: name === STOP ? true : binding.retired, subscription });
      return subscription;
    }
    return this.withClient(async (events) => {
      const definition = (await this.catalog(events)).find(
        (event) => actionName(event.name) === name,
      );
      if (definition === undefined)
        throw new Error("Unknown event subscription action for this account.");
      const schema =
        typeof definition.inputSchema === "boolean"
          ? { allOf: [definition.inputSchema] }
          : definition.inputSchema;
      const valid = await toInputSchema(schema)["~standard"].validate(
        parseJsonObject(args.arguments),
      );
      if (valid.issues !== undefined)
        throw new Error("Event arguments do not match the authorized catalog schema.");
      const eventArguments = parseJsonObject(valid.value);
      const expiresAt = args.expiresAt;
      if (
        expiresAt !== null &&
        (typeof expiresAt !== "string" ||
          !z.iso.datetime({ offset: true }).safeParse(expiresAt).success)
      )
        throw new Error("expiresAt must be an ISO deadline or null.");
      const id = createHash("sha256")
        .update(
          JSON.stringify([
            sessionId,
            this.connection.instanceId,
            this.connection.connectionName,
            owner,
            executionPrincipal,
            options.callId,
          ]),
        )
        .digest("hex");
      let binding = currentState().bindings[id];
      if (binding === undefined) {
        if (Object.keys(currentState().bindings).length >= MAX_BINDINGS)
          throw new Error("This session has reached its 100-subscription limit.");
        const request: ManagedEventSubscribeInput = {
          name: definition.name,
          arguments: structuredClone(eventArguments) as ManagedEventSubscribeInput["arguments"],
          expiresAt,
          idempotencyKey: id,
          context: { eve: { version: 1, sessionId, bindingId: id } },
        };
        binding = {
          id,
          sessionId,
          connectionName: this.connection.connectionName,
          instanceId: this.connection.instanceId,
          connector,
          principalKey: owner,
          executionPrincipal,
          auth: structuredClone(ctx.get(AuthKey) ?? null),
          request,
        };
        save(binding);
      }
      if (!owned(binding) || binding.retired)
        throw new Error("Subscription binding is no longer active.");
      if (binding.subscription !== undefined) return binding.subscription;
      const subscription = await events.subscribe({
        ...binding.request,
        options: { signal: options.abortSignal, timeout: 30_000 },
      });
      save({ ...binding, subscription });
      return subscription;
    });
  }
}

function actionName(eventName: string): string {
  return `${PREFIX}${createHash("sha256").update(eventName).digest("hex").slice(0, 24)}`;
}
