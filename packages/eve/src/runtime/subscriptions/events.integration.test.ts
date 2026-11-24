import * as workflowRuntime from "#execution/workflow-runtime.js";
import { installWorkflowHost } from "#execution/workflow-host/host.js";
import { eventTracing } from "#internal/testing/event-tracing.js";
import { parseJsonValue } from "#shared/json.js";
import { trace } from "@opentelemetry/api";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import { compileFromMemory } from "#internal/testing/compile-from-memory.js";
import { resolveRuntimeAgentGraph } from "#runtime/resolve-agent-graph.js";
import { createRuntimeAdapterRegistry } from "#runtime/channels/registry.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";
import { afterEach, beforeEach, expect, it, vi, onTestFinished } from "vitest";
import { ContextContainer, contextStorage, loadContext } from "#context/container.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { fromCompiledBundle } from "#definitions/compiled-agent.js";
import { requireCompiledBundle, SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  ConnectionEventActions,
  EVENT_STOP_ACTION,
  EVENT_SUBSCRIBE_ACTION,
} from "#runtime/subscriptions/actions.js";
import { startSubscriptionOwner } from "#runtime/subscriptions/owner.js";
import type {
  ConnectionBinding,
  OpenedSubscription,
  SubscriptionEvent,
} from "#runtime/subscriptions/state.js";
import {
  closeSubscriptionStep,
  dispatchSubscriptionStep,
  fanOutEventStep,
  openSubscriptionStep,
} from "#runtime/subscriptions/steps.js";
import { isMcpAuthRequiredError } from "#runtime/connections/mcp-client.js";
import { listToolMetadata } from "#execution/catalog/connection-auth.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type {
  ConnectionEventDelivery,
  ConnectionEventsAdapter,
  ManagedEventSubscribeInput,
  ManagedEventSubscription,
} from "#shared/connection-events.js";

const { createClient, loadBundle, handlers, retired, workflowRunId, ownerHooks } = vi.hoisted(
  () => ({
    createClient: vi.fn(),
    workflowRunId: { current: "wrun_1" },
    ownerHooks: {
      routed: false,
      deliveries: [] as Promise<void>[],
    },
    loadBundle: vi.fn(),
    handlers: new Map<
      string,
      { binding: ConnectionBinding; opened: OpenedSubscription | undefined }
    >(),
    retired: new Set<string>(),
  }),
);
vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getWorkflowMetadata: () => ({ workflowRunId: workflowRunId.current }),
  getWritable: () => new WritableStream(),
}));
vi.mock("#internal/workflow/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#internal/workflow/runtime.js")>();
  return {
    ...actual,
    resumeHook: async (token: string, message: unknown) => {
      if (!ownerHooks.routed) return actual.resumeHook(token, message as never);
      const { HookNotFoundError } = await import("#compiled/@workflow/errors/index.js");
      const bindingId = token.replace(/^eve:subscription:/, "");
      const handler = handlers.get(bindingId);
      if (handler === undefined || bindingId === token) throw new HookNotFoundError(token);
      const { event } = message as { event: SubscriptionEvent };
      ownerHooks.deliveries.push(
        dispatchSubscriptionStep({
          binding: handler.binding,
          event,
        }),
      );
      return {} as never;
    },
  };
});
vi.mock("#compiled/@ai-sdk/mcp/index.js", () => ({ createMCPClient: createClient }));
vi.mock("#runtime/subscriptions/owner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#runtime/subscriptions/owner.js")>();
  return {
    ...actual,
    startSubscriptionOwner: vi.fn(async (binding: ConnectionBinding, bundle: unknown) => {
      const existing = handlers.get(binding.id);
      if (existing !== undefined) return existing.opened;
      const { connectionSource } = await import("#runtime/subscriptions/sources/connection.js");
      const outcome = await connectionSource.open({
        ctx: await deserializeContext(handlerContext(binding, bundle)),
        binding,
        idempotencyKey: binding.id,
      });
      if ("error" in outcome)
        throw Object.assign(new Error(outcome.error), { status: outcome.status });
      handlers.set(binding.id, { binding, opened: outcome.opened });
      return outcome.opened;
    }),
    findSubscriptionOwner: vi.fn(async (bindingId: string) => handlers.get(bindingId)),
    retireSubscriptionOwner: vi.fn(async (bindingId: string) => {
      if (!handlers.has(bindingId)) return false;
      retired.add(bindingId);
      return true;
    }),
  };
});
vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: loadBundle,
}));
vi.mock("#execution/terminal-session-completion-step.js", () => ({
  emitTerminalSessionCompletionStep: vi.fn(),
}));
installWorkflowHost();

let ctx: ContextContainer;
let actions: ConnectionEventActions;
let connection: ResolvedConnectionDefinition;
let requested: ManagedEventSubscribeInput[];
let adapter: ConnectionEventsAdapter;
let saved: Map<string, ManagedEventSubscription>;
let subscriber: ReturnType<typeof vi.fn<ConnectionEventsAdapter["subscribe"]>>;
let callback: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<void>>>;
let gap: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<void>>>;
let terminated: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<void>>>;
let initial: {
  serializedContext: Record<string, unknown>;
  binding: ConnectionBinding | undefined;
};
let eventSchema: Record<string, unknown>;

beforeEach(async () => {
  eventSchema = {
    type: "object",
    properties: { project: { type: "string" } },
    required: ["project"],
    additionalProperties: false,
  };
  requested = [];
  saved = new Map();
  handlers.clear();
  retired.clear();
  ownerHooks.routed = false;
  ownerHooks.deliveries = [];
  callback = vi.fn(async () => {});
  gap = vi.fn(async () => {});
  terminated = vi.fn(async () => {});
  subscriber = vi.fn(async (input: ManagedEventSubscribeInput) => {
    requested.push(input);
    const existing = saved.get(input.idempotencyKey);
    if (existing) return existing;
    const subscription: ManagedEventSubscription = {
      id: `sub_${saved.size}`,
      name: input.name,
      arguments: input.arguments,
      status: "active",
      expiresAt: null,
    };
    saved.set(input.idempotencyKey, subscription);
    return subscription;
  });
  adapter = {
    subscribe: subscriber,
    getSubscription: vi.fn(),
    unsubscribe: vi.fn(async () => ({
      ...saved.values().next().value!,
      status: "stopped" as const,
    })),
  };
  connection = {
    connectionName: "issues",
    instanceId: "issues-v1",
    description: "Issue events",
    url: "https://issues.example/mcp",
    protocol: "mcp",
    logicalPath: "connections/issues.ts",
    sourceId: "issues",
    sourceKind: "module",
    authorization: {
      principalType: "user",
      getToken: vi.fn(async () => ({ token: "test-token" })),
      vercelConnect: {
        connector: "oauth/issues",
        experimental_events: { createAdapter: vi.fn(async () => adapter), verify: vi.fn() },
      },
    },
  };
  const { manifest, moduleMap } = await compileFromMemory({
    model: "openai/gpt-5.4",
    modules: [
      {
        logicalPath: "connections/issues.ts",
        loadNamespace: async () => ({
          default: defineMcpClientConnection({
            url: connection.url,
            description: connection.description,
            auth: connection.authorization,
            experimental: { events: { onEvent: callback, onGap: gap, onTerminated: terminated } },
          }),
        }),
      },
    ],
  });
  const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });
  const root = graph.root;
  connection = root.agent.connections[0]!;
  const bundle: CompiledRuntimeAgentBundle = {
    adapterRegistry: createRuntimeAdapterRegistry({ channels: root.channels }),
    compiledArtifactsSource: { kind: "disk", appRoot: "/virtual/events" },
    graph,
    modelMetadata: undefined as never,
    moduleMap,
    resolvedAgent: root.agent,
    subagentRegistry: root.subagentRegistry,
    toolRegistry: root.toolRegistry,
    turnAgent: root.turnAgent,
  };
  loadBundle.mockResolvedValue(bundle);
  createClient.mockImplementation(async (config) => ({
    close: vi.fn(),
    listTools: async () => ({ tools: [] }),
    toolsFromDefinitions: () => ({}),
    experimental_events: {
      list: async () => ({
        events: [
          {
            name: `${config.transport.headers.account}.issue.created`,
            delivery: ["webhook"],
            inputSchema: eventSchema,
          },
        ],
      }),
    },
  }));
  ctx = new ContextContainer();
  ctx.set(SessionAgentKey, fromCompiledBundle(bundle));
  ctx.set(SessionIdKey, "session-1");
  setUser("alice");
  actions = new ConnectionEventActions(connection, connection.experimental_events!, async () => ({
    account: ctx.require(AuthKey)!.principalId,
  }));
  initial = {
    serializedContext: {},
    binding: undefined,
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

it.each([3_600_000, null])(
  "discovers through the released AI SDK and subscribes through the backend with ttlMs=%s",
  async (ttlMs) => {
    const tracing = eventTracing();
    tracing.enable();
    onTestFinished(() => tracing.close());
    const traceparents: string[] = [];
    const { createMCPClient } = await vi.importActual<
      typeof import("#compiled/@ai-sdk/mcp/index.js")
    >("#compiled/@ai-sdk/mcp/index.js");
    createClient.mockImplementation(createMCPClient);
    const methods: string[] = [];
    const transportFetch: typeof fetch = async (_url, init) => {
      if (init?.method !== "POST") return new Response(null, { status: 405 });
      const request = JSON.parse(String(init.body));
      methods.push(request.method);
      if (request.id === undefined) return new Response(null, { status: 202 });
      if (request.method === "server/discover") {
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: "Method not found" },
        });
      }
      let result;
      if (request.method === "initialize") {
        result = {
          protocolVersion: "2025-11-25",
          serverInfo: { name: "test-events", version: "1" },
          capabilities: { events: {} },
        };
      } else if (request.method === "events/list") {
        traceparents.push(request.params?._meta?.traceparent);
        result = {
          events: [
            {
              name: "issue.created",
              delivery: ["webhook"],
              inputSchema: eventSchema,
              payloadSchema: { type: "object" },
            },
          ],
        };
      } else {
        throw new Error(`Unexpected upstream request: ${request.method}`);
      }
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    };
    actions = new ConnectionEventActions(
      connection,
      connection.experimental_events!,
      async () => ({ Authorization: "Bearer test" }),
      transportFetch,
    );
    await watch("watch-1", ttlMs, "issue.created");
    expect(methods.filter((method) => method === "events/list")).toHaveLength(1);
    expect(methods).not.toContain("events/subscribe");
    const catalogSpans = tracing.exporter
      .getFinishedSpans()
      .filter((span) => span.name === "events/list");
    expect(catalogSpans).toHaveLength(1);
    expect(traceparents).toEqual(
      catalogSpans.map(
        (span) => `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`,
      ),
    );
    expect(catalogSpans.map((span) => span.attributes["mcp.method.name"])).toEqual(["events/list"]);
    expect(
      tracing.exporter
        .getFinishedSpans()
        .find((span) => span.name === "agent.connection.event.subscribe")?.attributes,
    ).toMatchObject({
      "connect.subscription.id": "sub_0",
      "connect.subscription.status": "active",
    });
    expect(subscriber).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "issue.created", arguments: { project: "ABC" }, ttlMs }),
    );
    expect(handlers.get(initial.binding!.id)?.opened?.upstream?.id).toBe("sub_0");
  },
);

it.each([120_000, 31_536_000_000, null])(
  "subscribes with the requested ttlMs=%s and preserves it in the handler's input",
  async (ttlMs) => {
    await watch("watch-1", ttlMs);
    expect(requested[0]).toMatchObject({ ttlMs, idempotencyKey: initial.binding!.id });
    expect(requested[0]).not.toHaveProperty("expiresAt");
    expect(initial.binding!.source.request.ttlMs).toBe(ttlMs);
  },
);

it.each([
  {},
  { expiresAt: null },
  { ttlMs: 119_999 },
  { ttlMs: 120_000.5 },
  { ttlMs: 31_536_000_001 },
  { ttlMs: "120000" },
  { ttlMs: 120_000, expiresAt: null },
])("rejects invalid subscription input %j before starting a watch", async (lifetime) => {
  const input = { event: eventName(), arguments: { project: "ABC" }, ...lifetime };
  await expect(
    contextStorage.run(ctx, () =>
      actions.execute(EVENT_SUBSCRIBE_ACTION, input, { callId: "invalid" }),
    ),
  ).rejects.toThrow("Invalid subscription input");
  expect(subscriber).not.toHaveBeenCalled();
  expect(handlers.size).toBe(0);
});

it.each([{ ttlMs: 1 }, { ttlMs: 120_000, expiresAt: null }])(
  "rejects invalid subscription input %j even when the provider schema cannot be validated",
  async (lifetime) => {
    eventSchema = { type: "object", properties: { project: { type: "provider-specific" } } };
    await expect(
      contextStorage.run(ctx, () =>
        actions.execute(
          EVENT_SUBSCRIBE_ACTION,
          { event: eventName(), arguments: { project: "ABC" }, ...lifetime },
          { callId: "invalid" },
        ),
      ),
    ).rejects.toThrow("Invalid subscription input");
    expect(subscriber).not.toHaveBeenCalled();
    expect(handlers.size).toBe(0);
  },
);

it.each(["available", "catalog unavailable", "connection unavailable"])(
  "subscribes and stops through the connection's event actions with MCP %s",
  async (availability) => {
    connection = { ...connection, headers: { account: "alice" } };
    const registry = new ConnectionRegistryImpl([connection]);
    try {
      await contextStorage.run(ctx, async () => {
        const manage = (name: string, input: unknown) =>
          registry
            .getClient(connection.connectionName)
            .eventActions!.execute(name, input, { callId: name });
        const created = (await manage(EVENT_SUBSCRIBE_ACTION, {
          event: "alice.issue.created",
          arguments: { project: "ABC" },
          ttlMs: TTL_MS,
        })) as { id: string };
        expect(created).toMatchObject({ subscriptionId: "sub_0", status: "active" });
        expect(requested[0]!.arguments).toEqual({ project: "ABC" });
        if (availability !== "available") {
          if (availability === "connection unavailable") await registry.dispose();
          createClient.mockRejectedValue(new Error("MCP unavailable"));
          setUser("bob");
          await expect(manage(EVENT_STOP_ACTION, { id: created.id })).rejects.toThrow(
            "Unknown subscription",
          );
          setUser("alice");
        }
        expect(await manage(EVENT_STOP_ACTION, { id: created.id })).toEqual({
          id: created.id,
          status: "stopping",
        });
        expect(retired.has(created.id)).toBe(true);
      });
    } finally {
      await registry.dispose();
    }
  },
);

it("lists the connection's events with their descriptions and schemas, and none of them as tools", async () => {
  eventSchema = { ...eventSchema, description: "Scoped to one project." };
  createClient.mockImplementation(async (config) => ({
    close: vi.fn(),
    listTools: async () => ({ tools: [] }),
    toolsFromDefinitions: () => ({}),
    experimental_events: {
      list: async () => ({
        events: [
          {
            name: `${config.transport.headers.account}.issue.created`,
            description: "An issue was created.",
            delivery: ["webhook"],
            inputSchema: eventSchema,
          },
          { name: "polled.only", delivery: ["poll"], inputSchema: eventSchema },
          { name: "alice.issue.closed", delivery: ["webhook"] },
        ],
      }),
    },
  }));
  connection = { ...connection, headers: { account: "alice" } };
  const registry = new ConnectionRegistryImpl([connection]);
  try {
    await contextStorage.run(ctx, async () => {
      const client = registry.getClient(connection.connectionName);
      expect(await client.eventActions!.list()).toEqual([
        {
          name: "alice.issue.created",
          description: "An issue was created.",
          inputSchema: eventSchema,
        },
        { name: "alice.issue.closed", description: "", inputSchema: { type: "object" } },
      ]);
      expect(await listToolMetadata(connection, client)).toEqual([]);
    });
  } finally {
    await registry.dispose();
  }
});

it("rejects an event the connection does not emit, naming the closest events and where to find them", async () => {
  const error = await watch("watch-1", TTL_MS, "alice.issue.creatd").then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof Error)) throw new Error("Expected the subscribe to be refused.");
  expect(error.message).toContain('Connection "issues" emits no event named "alice.issue.creatd".');
  expect(error.message).toContain("Closest events: alice.issue.created.");
  expect(error.message).toContain("eve__search");
  expect(error.message).toContain("subscriptions__issues__");
  expect(subscriber).not.toHaveBeenCalled();
  expect(handlers.size).toBe(0);
});

it("runs callbacks in the creator's eve context", async () => {
  await watch();
  setUser("bob");
  initial = { ...initial, serializedContext: serializeContext(ctx) };
  callback.mockImplementation(async () => {
    expect(loadContext().require(AuthKey)?.principalId).toBe("alice");
  });
  await dispatch(payload());
  expect(callback).toHaveBeenCalledTimes(1);
});

it("uses eve tool schema defaults and treats format as an annotation for event arguments", async () => {
  eventSchema = {
    type: "object",
    $defs: {
      project: { type: "string", format: "email" },
      includeArchived: { type: "boolean", default: false },
    },
    properties: {
      project: { $ref: "#/$defs/project" },
      includeArchived: { $ref: "#/$defs/includeArchived" },
    },
  };
  await watch();
  expect(requested[0]!.arguments).toEqual({ project: "ABC", includeArchived: false });
});
function setUser(id: string) {
  ctx.set(AuthKey, {
    principalId: id,
    principalType: "user",
    authenticator: "test",
    issuer: "https://identity.example",
    attributes: {},
  });
}
const TTL_MS = 3_600_000;
function eventName() {
  return `${ctx.require(AuthKey)!.principalId}.issue.created`;
}
async function watch(
  callId = "watch-1",
  ttlMs: number | null = TTL_MS,
  event: string = eventName(),
) {
  return contextStorage.run(ctx, async () => {
    try {
      return (await actions.execute(
        EVENT_SUBSCRIBE_ACTION,
        { event, arguments: { project: "ABC" }, ttlMs },
        { callId },
      )) as ManagedEventSubscription & { subscriptionId: string };
    } finally {
      initial = { ...initial, binding: [...handlers.values()].at(-1)?.binding };
    }
  });
}
function handlerContext(binding: ConnectionBinding, bundle: unknown): Record<string, unknown> {
  const handler = new ContextContainer();
  handler.set(SessionAgentKey, fromCompiledBundle(bundle as CompiledRuntimeAgentBundle));
  handler.set(AuthKey, binding.auth);
  handler.set(SessionIdKey, binding.sessionId);
  return serializeContext(handler);
}
function deliveryFor(
  eventName: string,
  subscriptionId: string,
  deliveryId: string,
): ConnectionEventDelivery {
  return {
    version: 1,
    deliveryId,
    subscriptionId,
    source: { type: "mcp", connectorId: "connector" },
    context: {},
    event: {
      eventId: "event-1",
      name: eventName,
      timestamp: "2026-10-07T00:00:00Z",
      data: { issue: "ABC-1" },
      cursor: null,
    },
  };
}
function eventOf(
  delivery: ConnectionEventDelivery,
  requestTraceContext?: SubscriptionEvent["requestTraceContext"],
): SubscriptionEvent {
  const base = {
    id: delivery.deliveryId,
    data: parseJsonValue(delivery),
    origin: {
      deploymentId: "dpl_receiver",
      compiledArtifactsSource: { kind: "disk" as const, appRoot: "/virtual/events" },
    },
  };
  return requestTraceContext === undefined ? base : { ...base, requestTraceContext };
}
function controlOf(
  delivery: ConnectionEventDelivery,
  control: Extract<ConnectionEventDelivery, { control: unknown }>["control"],
): ConnectionEventDelivery {
  const { event: _event, ...envelope } = delivery as Extract<
    ConnectionEventDelivery,
    { event: unknown }
  >;
  return { ...envelope, control } as ConnectionEventDelivery;
}
function delivery(): ConnectionEventDelivery {
  return deliveryFor(initial.binding!.source.request.name, "sub_0", "delivery-1");
}
function payload(): SubscriptionEvent {
  return eventOf(delivery());
}
async function dispatch(event: SubscriptionEvent, binding = initial.binding!) {
  await dispatchSubscriptionStep({ binding, event });
}

it.each(["user", "app"] as const)(
  "isolates subscription management between users sharing a %s credential",
  async (principalType) => {
    const auth = connection.authorization;
    if (auth === undefined || typeof auth === "function") throw new Error("Missing fixture auth");
    const authorization = {
      principalType,
      getToken: auth.getToken,
      vercelConnect: auth.vercelConnect,
    };
    connection = {
      ...connection,
      authorization,
      experimental_events: { ...connection.experimental_events!, authorization },
    };
    (requireCompiledBundle(ctx).resolvedAgent.connections as ResolvedConnectionDefinition[])[0] =
      connection;
    actions = new ConnectionEventActions(connection, connection.experimental_events!, async () => ({
      account: ctx.require(AuthKey)!.principalId,
    }));
    const { id } = await watch();
    setUser("bob");
    const listed = await contextStorage.run(ctx, () => actions.list());
    expect(listed.map(({ name }) => name)).toEqual(["bob.issue.created"]);
    await expect(
      contextStorage.run(ctx, () =>
        actions.execute(EVENT_STOP_ACTION, { id }, { callId: EVENT_STOP_ACTION }),
      ),
    ).rejects.toThrow("Unknown subscription");
    expect(adapter.unsubscribe).not.toHaveBeenCalled();
    setUser("alice");
    await watch();
    expect(subscriber).toHaveBeenCalledTimes(1);
  },
);

it("rejects invalid event arguments before subscription and fixes destination/identity outside model input", async () => {
  await contextStorage.run(ctx, async () => {
    await expect(
      actions.execute(
        EVENT_SUBSCRIBE_ACTION,
        { event: eventName(), arguments: { project: 42 }, ttlMs: TTL_MS },
        { callId: "invalid" },
      ),
    ).rejects.toThrow("catalog schema");
  });
  expect(subscriber).not.toHaveBeenCalled();
  await watch();
  expect(requested[0]!.context).toMatchObject({ eve: { version: 1, sessionId: "session-1" } });
});

it("keeps a 401 from subscribe classifiable as a sign-in request", async () => {
  subscriber.mockRejectedValueOnce(Object.assign(new Error("Unauthorized"), { status: 401 }));
  const failure = await watch().catch((error: unknown) => error);
  expect(isMcpAuthRequiredError(failure)).toBe(true);
  expect(handlers.size).toBe(0);
});

it("throws when a subscribe response is lost, so the step retries with the same key", async () => {
  await watch();
  const binding: ConnectionBinding = { ...initial.binding!, id: "lost" };
  const open = () =>
    openSubscriptionStep({
      serializedContext: handlerContext(binding, requireCompiledBundle(ctx)),
      binding,
    });
  const subscribe = subscriber.getMockImplementation()!;
  subscriber.mockImplementationOnce(async (input) => {
    await subscribe(input);
    throw new Error("The operation timed out.");
  });
  await expect(open()).rejects.toThrow("timed out");
  const opened = await open();
  expect(opened).toEqual({
    opened: {
      key: [...saved.values()].at(-1)!.id,
      expiresAt: null,
      upstream: [...saved.values()].at(-1),
    },
  });
  expect(saved.size).toBe(2);
});

it("fails the subscribe action with Connect's error, and a retry reuses its idempotency key", async () => {
  subscriber.mockRejectedValueOnce(new Error("MCP Events provider request failed."));
  await expect(watch()).rejects.toThrow("MCP Events provider request failed.");
  expect(handlers.size).toBe(0);
  await watch();
  const [failed, retried] = subscriber.mock.calls.map(([input]) => input);
  expect(failed?.idempotencyKey).toBe(retried?.idempotencyKey);
});

it("runs callbacks as the creator under the run's saved binding", async () => {
  await watch();
  const message = payload();
  setUser("bob");
  initial = { ...initial, serializedContext: serializeContext(ctx) };
  await dispatch(message);
  expect(callback).toHaveBeenCalledWith(
    expect.objectContaining({
      auth: expect.objectContaining({ principalId: "alice" }),
      origin: { sessionId: "session-1", connectionName: "issues", subscriptionId: "sub_0" },
    }),
  );
});

it("does not run a delivery whose connection or event name differs from its binding", async () => {
  await watch();
  initial = { ...initial, serializedContext: serializeContext(ctx) };
  const binding = initial.binding!;
  await dispatch(payload(), { ...binding, source: { ...binding.source, name: "other" } });
  await dispatch(eventOf(deliveryFor("other.event", "sub_0", "delivery-1")));
  expect(callback).not.toHaveBeenCalled();
  await dispatch(payload());
  expect(callback).toHaveBeenCalledTimes(1);
});

it("returns the same watch when the same event and arguments are watched again", async () => {
  eventSchema = {
    type: "object",
    properties: { project: { type: "string" }, team: { type: "string" } },
    additionalProperties: false,
  };
  const ask = (callId: string, eventArguments: Record<string, string>) =>
    contextStorage.run(ctx, async () => {
      return (await actions.execute(
        EVENT_SUBSCRIBE_ACTION,
        { event: eventName(), arguments: eventArguments, ttlMs: TTL_MS },
        { callId },
      )) as { id: string };
    });
  const first = await ask("cancelled", { project: "ABC", team: "core" });
  const again = await ask("retry", { team: "core", project: "ABC" });
  expect(again.id).toBe(first.id);
  expect(subscriber).toHaveBeenCalledTimes(1);
  const other = await ask("other", { project: "XYZ", team: "core" });
  expect(other.id).not.toBe(first.id);
});

it("keys Connect's subscribe by watch and run, so a step retry reuses it and a later run does not", async () => {
  await watch();
  const binding = initial.binding!;
  const open = () =>
    openSubscriptionStep({
      serializedContext: handlerContext(binding, requireCompiledBundle(ctx)),
      binding,
    });
  workflowRunId.current = "wrun_1";
  const first = await open();
  const retried = await open();
  workflowRunId.current = "wrun_2";
  const later = await open();
  const keys = requested.slice(-3).map((input) => input.idempotencyKey);
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).not.toBe(keys[0]);
  expect(retried).toEqual(first);
  expect(later).not.toEqual(first);
});

it("returns a subscribe that outlasts the wait as pending under its id", async () => {
  vi.mocked(startSubscriptionOwner).mockImplementationOnce(async (binding) => {
    handlers.set(binding.id, { binding: binding as ConnectionBinding, opened: undefined });
    return undefined;
  });
  const pending = await watch();
  expect(pending).toEqual({
    id: initial.binding!.id,
    name: initial.binding!.source.request.name,
    arguments: { project: "ABC" },
    status: "pending",
  });
});

it("takes a stop while the subscribe is still in flight, for the watch's run to carry out", async () => {
  vi.mocked(startSubscriptionOwner).mockImplementationOnce(async (binding) => {
    handlers.set(binding.id, { binding: binding as ConnectionBinding, opened: undefined });
    return undefined;
  });
  const { id } = await watch();
  await contextStorage.run(ctx, async () => {
    expect(await actions.execute(EVENT_STOP_ACTION, { id }, { callId: "stop" })).toEqual({
      id,
      status: "stopping",
    });
  });
  expect(retired.has(id)).toBe(true);
});

it("ends the watch after its terminated callback", async () => {
  await watch();
  initial = { ...initial, serializedContext: serializeContext(ctx) };
  await dispatch(
    eventOf(controlOf(delivery(), { type: "terminated", error: { code: 1, message: "Ended" } })),
  );
  expect(terminated).toHaveBeenCalledTimes(1);
  expect(retired.has(initial.binding!.id)).toBe(true);
  expect(callback).not.toHaveBeenCalled();
});

it("fails the step when a callback fails, so its delivery run retries it", async () => {
  await watch();
  initial = { ...initial, serializedContext: serializeContext(ctx) };
  const message = payload();
  callback.mockRejectedValueOnce(new Error("temporary failure"));
  await expect(dispatch(message)).rejects.toThrow("temporary failure");
  await dispatch(message);
  expect(callback).toHaveBeenCalledTimes(2);
  expect(retired.size).toBe(0);
});

it("lets the creator stop a watch from a later session by its id", async () => {
  const { id } = await watch();
  ctx.set(SessionIdKey, "session-2");
  await contextStorage.run(ctx, async () => {
    expect(await actions.execute(EVENT_STOP_ACTION, { id }, { callId: "stop" })).toEqual({
      id,
      status: "stopping",
    });
  });
  expect(adapter.unsubscribe).not.toHaveBeenCalled();
  expect(retired.has(id)).toBe(true);
});

it("refuses a stop of a watch whose run has finished", async () => {
  const { id } = await watch();
  await contextStorage.run(ctx, async () => {
    await actions.execute(EVENT_STOP_ACTION, { id }, { callId: "stop" });
  });
  handlers.delete(id);
  await contextStorage.run(ctx, async () => {
    await expect(
      actions.execute(EVENT_STOP_ACTION, { id }, { callId: "stop-after" }),
    ).rejects.toThrow("Unknown subscription");
  });
});

it.each([
  ["pending", { cleanupStatus: "pending" as const }, "pending"],
  ["complete", { cleanupStatus: "complete" as const }, "done"],
  ["already removed", Object.assign(new Error("Not found"), { status: 404 }), "done"],
  ["gone", Object.assign(new Error("Gone"), { status: 410 }), "done"],
  ["unauthorized", Object.assign(new Error("Unauthorized"), { status: 401 }), "pending"],
  ["forbidden", Object.assign(new Error("Forbidden"), { status: 403 }), "pending"],
  ["unavailable", Object.assign(new Error("Connect unavailable"), { status: 503 }), "pending"],
  ["unreachable", new Error("fetch failed"), "pending"],
])(
  "reads Connect's unsubscribe answer for the watch's run: %s",
  async (_name, answer, expected) => {
    await watch();
    const subscription = saved.values().next().value!;
    if (answer instanceof Error) vi.mocked(adapter.unsubscribe).mockRejectedValueOnce(answer);
    else vi.mocked(adapter.unsubscribe).mockResolvedValueOnce({ ...subscription, ...answer });
    const binding = initial.binding!;
    expect(
      await closeSubscriptionStep({
        serializedContext: handlerContext(binding, requireCompiledBundle(ctx)),
        binding,
        opened: { key: subscription.id, expiresAt: null },
      }),
    ).toBe(expected);
    expect(adapter.unsubscribe).toHaveBeenCalledWith(
      expect.objectContaining({ id: subscription.id }),
    );
  },
);

it("records a gap before dispatch and keeps the subscription available for later events", async () => {
  await watch();
  initial = { ...initial, serializedContext: serializeContext(ctx) };
  await dispatch(
    eventOf(controlOf(delivery(), { type: "gap", cursor: "cursor-2", truncated: true })),
  );
  expect(gap).toHaveBeenCalledTimes(1);
  await dispatch(eventOf({ ...delivery(), deliveryId: "next" }));
  expect(callback).toHaveBeenCalledTimes(1);
});

it.each(["event", "gap", "terminated"] as const)(
  "traces each durable %s callback attempt under its saved receipt context",
  async (kind) => {
    const tracing = eventTracing();
    tracing.enable();
    const logging = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await watch();
      initial = { ...initial, serializedContext: serializeContext(ctx) };
      const normal = delivery();
      const tracedMessage = eventOf(
        kind === "event"
          ? normal
          : controlOf(
              normal,
              kind === "gap"
                ? { type: "gap", cursor: null }
                : { type: "terminated", error: { code: 1, message: "private" } },
            ),
        { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 },
      );
      const handler = kind === "event" ? callback : kind === "gap" ? gap : terminated;
      const active: string[] = [];
      handler
        .mockImplementationOnce(async () => {
          active.push(trace.getActiveSpan()!.spanContext().spanId);
          throw new Error("secret-callback-payload");
        })
        .mockImplementationOnce(async () => {
          active.push(trace.getActiveSpan()!.spanContext().spanId);
        });
      await expect(dispatch(tracedMessage)).rejects.toThrow("secret-callback-payload");
      await dispatch(JSON.parse(JSON.stringify(tracedMessage)));
      const spans = tracing.exporter
        .getFinishedSpans()
        .filter((span) => span.name.startsWith("agent.connection.event.on"));
      expect(spans).toHaveLength(2);
      expect(active).toEqual(spans.map((span) => span.spanContext().spanId));
      expect(new Set(active).size).toBe(2);
      expect(spans.map((span) => span.parentSpanContext?.spanId)).toEqual([
        "2".repeat(16),
        "2".repeat(16),
      ]);
      expect(spans.map((span) => span.status.code)).toEqual([2, 1]);
      expect(spans[1]!.attributes).toMatchObject({
        "agent.run.id": "session-1",
        "connect.subscription.id": "sub_0",
        "connect.delivery.id": "delivery-1",
      });
      expect(
        JSON.stringify([spans.map((s) => [s.attributes, s.events, s.status]), logging.mock.calls]),
      ).not.toContain("secret-callback-payload");
    } finally {
      logging.mockRestore();
      await tracing.close();
    }
  },
);

it("honors disabled tracing and a dropped session policy without preventing event callbacks", async () => {
  const tracing = eventTracing();
  try {
    for (const enabled of [false, true]) {
      if (enabled) tracing.enable(() => false);
      await watch();
      initial = { ...initial, serializedContext: serializeContext(ctx) };
      await dispatch(payload());
    }
    expect(callback).toHaveBeenCalledTimes(2);
    expect(tracing.exporter.getFinishedSpans()).toEqual([]);
  } finally {
    await tracing.close();
  }
});

it("links callback sends to the callback span through durable channel delivery metadata", async () => {
  const tracing = eventTracing();
  tracing.enable();
  onTestFinished(() => tracing.close());
  await watch();
  initial = { ...initial, serializedContext: serializeContext(ctx) };
  const runtime = workflowRuntime.createWorkflowRuntime({
    compiledArtifactsSource: requireCompiledBundle(ctx).compiledArtifactsSource,
  });
  const send = vi.fn().mockResolvedValue({ status: "accepted" });
  vi.spyOn(workflowRuntime, "createWorkflowRuntime").mockReturnValue({
    ...runtime,
    dispatchSession: send,
  });
  callback.mockImplementation(async (args) => {
    const event = args as Parameters<
      NonNullable<typeof connection.experimental_events>["callbacks"]["onEvent"]
    >[0];
    await event
      .attachSession(event.origin.sessionId)
      .send("check this event", { auth: event.auth });
  });
  await dispatch(payload());
  const span = tracing.exporter
    .getFinishedSpans()
    .find((span) => span.name === "agent.connection.event.onEvent")!;
  expect(JSON.parse(JSON.stringify(send.mock.calls[0]![0]))).toMatchObject({
    sessionId: "session-1",
    command: {
      turnPolicy: "queue",
      requestId: "delivery-1",
      delivery: {
        channelKind: "mcp-events",
        channelName: "issues",
        requestId: "delivery-1",
        requestTraceContext: {
          traceId: span.spanContext().traceId,
          spanId: span.spanContext().spanId,
          traceFlags: 1,
        },
      },
    },
  });
});

it("does not let a sampled webhook override the session's saved sampling decision", async () => {
  const tracing = eventTracing();
  tracing.enable();
  onTestFinished(() => tracing.close());
  await watch();
  tracing.exporter.reset();
  const traceSeed = {
    traceId: "3".repeat(32),
    spanId: "4".repeat(16),
    traceFlags: 0,
    decision: { action: "record" as const, recordInputs: false, recordOutputs: false },
  };
  await dispatch(
    eventOf(delivery(), { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 }),
    { ...initial.binding!, traceSeed },
  );
  expect(callback).toHaveBeenCalledOnce();
  expect(tracing.exporter.getFinishedSpans()).toEqual([]);
});

it("delivers one upstream event to every session holding the same upstream subscription, each once", async () => {
  subscriber.mockImplementation(async (input: ManagedEventSubscribeInput) => ({
    id: "sub_shared",
    name: input.name,
    arguments: input.arguments,
    status: "active",
    expiresAt: null,
  }));
  ownerHooks.routed = true;
  const bindings: ConnectionBinding[] = [];
  for (const sessionId of ["session-1", "session-2"]) {
    ctx.set(SessionIdKey, sessionId);
    await watch(`watch-${sessionId}`);
    bindings.push(initial.binding!);
  }
  const [first, second] = bindings as [ConnectionBinding, ConnectionBinding];
  expect(first.id).not.toBe(second.id);
  expect(handlers.get(first.id)!.opened!.key).toBe(handlers.get(second.id)!.opened!.key);

  const event = eventOf(deliveryFor(first.source.request.name, "sub_shared", "delivery-1"));
  expect(
    await fanOutEventStep({ bindingIds: [first.id, second.id, "ended-owner"], event }),
  ).toEqual(["ended-owner"]);
  await Promise.all(ownerHooks.deliveries);

  expect(callback).toHaveBeenCalledTimes(2);
  expect(
    callback.mock.calls
      .map(([args]) => (args as { origin: { sessionId: string } }).origin.sessionId)
      .sort(),
  ).toEqual(["session-1", "session-2"]);
  expect(callback).toHaveBeenCalledWith(
    expect.objectContaining({
      deliveryId: "delivery-1",
      origin: expect.objectContaining({ subscriptionId: "sub_shared" }),
    }),
  );
});
