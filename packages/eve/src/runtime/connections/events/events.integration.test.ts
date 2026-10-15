import * as workflowRuntime from "#execution/workflow-runtime.js";
import { eventTracing } from "#internal/testing/event-tracing.js";
import { trace } from "@opentelemetry/api";
import { connectionEntry } from "#execution/catalog/connection-entry.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import { compileFromMemory } from "#internal/testing/compile-from-memory.js";
import { resolveRuntimeAgentGraph } from "#runtime/resolve-agent-graph.js";
import { createRuntimeAdapterRegistry } from "#runtime/channels/registry.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";
import { afterEach, beforeEach, expect, it, vi, onTestFinished } from "vitest";
import { ContextContainer, contextStorage, loadContext } from "#context/container.js";
import { AuthKey, SessionIdKey, SessionTraceSeedKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { ConnectionEventActions } from "#runtime/connections/events/actions.js";
import type { EventBinding } from "#runtime/connections/events/state.js";
import { subscribeConnectionEvent } from "#runtime/connections/events/lifecycle-step.js";
import { isMcpAuthRequiredError } from "#runtime/connections/mcp-client.js";
import { dispatchConnectionEventStep } from "#runtime/connections/events/dispatch-step.js";
import type { ConnectionEventPayload } from "#runtime/connections/events/delivery.js";
import { listToolMetadata } from "#execution/catalog/connection-auth.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type {
  ConnectionEventsAdapter,
  ManagedEventSubscribeInput,
  ManagedEventSubscription,
} from "#shared/connection-events.js";

const { createClient, loadBundle, handlers, retired } = vi.hoisted(() => ({
  createClient: vi.fn(),
  loadBundle: vi.fn(),
  // Stands in for live handler runs: what each run holds in its own input and state.
  handlers: new Map<string, { binding: EventBinding; subscription: ManagedEventSubscription }>(),
  retired: new Set<string>(),
}));
vi.mock("#compiled/@ai-sdk/mcp/index.js", () => ({ createMCPClient: createClient }));
vi.mock("#runtime/connections/events/owner.js", () => ({
  // Subscribes the way the handler run's first step does.
  startConnectionEventOwner: vi.fn(async (binding: EventBinding, bundle: unknown) => {
    // A second run for the same binding conflicts on its hook and reads the first.
    const existing = handlers.get(binding.id);
    if (existing !== undefined) return existing.subscription;
    const { subscribeConnectionEvent } =
      await import("#runtime/connections/events/lifecycle-step.js");
    const { subscriptionFromOutcome } = await vi.importActual<
      typeof import("#runtime/connections/events/owner.js")
    >("#runtime/connections/events/owner.js");
    const subscription = subscriptionFromOutcome(
      await subscribeConnectionEvent(handlerContext(binding, bundle), binding),
    );
    handlers.set(binding.id, { binding, subscription });
    return subscription;
  }),
  findConnectionEventOwner: vi.fn(async (bindingId: string) => {
    const handler = handlers.get(bindingId);
    return handler && { owner: handler.binding, subscription: handler.subscription };
  }),
  // An ended run keeps its token, so the watch stays findable.
  retireConnectionEventOwner: vi.fn(async (bindingId: string) => {
    retired.add(bindingId);
  }),
}));
vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: loadBundle,
}));
vi.mock("#execution/terminal-session-completion-step.js", () => ({
  emitTerminalSessionCompletionStep: vi.fn(),
}));
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
  binding: EventBinding | undefined;
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
    listSubscriptions: vi.fn(),
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
            experimental_events: { onEvent: callback, onGap: gap, onTerminated: terminated },
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
    moduleMap,
    resolvedAgent: root.agent,
    hookRegistry: root.hookRegistry,
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
  ctx.set(BundleKey, bundle);
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
    await watch("watch-1", ttlMs);
    expect(methods.filter((method) => method === "events/list")).toHaveLength(2);
    expect(methods).not.toContain("events/subscribe");
    const catalogSpans = tracing.exporter
      .getFinishedSpans()
      .filter((span) => span.name === "events/list");
    expect(catalogSpans).toHaveLength(2);
    expect(traceparents).toEqual(
      catalogSpans.map(
        (span) => `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`,
      ),
    );
    expect(catalogSpans.map((span) => span.attributes["mcp.method.name"])).toEqual([
      "events/list",
      "events/list",
    ]);
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
    expect(handlers.get(initial.binding!.id)?.subscription.id).toBe("sub_0");
  },
);

it.each([120_000, 31_536_000_000, null])(
  "subscribes with the requested ttlMs=%s and preserves it in the handler's input",
  async (ttlMs) => {
    await watch("watch-1", ttlMs);
    expect(requested[0]).toMatchObject({ ttlMs, idempotencyKey: initial.binding!.id });
    expect(requested[0]).not.toHaveProperty("expiresAt");
    expect(initial.binding!.request.ttlMs).toBe(ttlMs);
    const [tool] = await contextStorage.run(ctx, () => actions.metadata());
    const { toInputSchema } = await import("#tools/schema.js");
    const schema = toInputSchema(tool!.inputSchema);
    expect(
      await schema["~standard"].validate({ arguments: { project: "ABC" }, ttlMs }),
    ).not.toHaveProperty("issues");
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
  const [tool] = await contextStorage.run(ctx, () => actions.metadata());
  const input = { arguments: { project: "ABC" }, ...lifetime };
  const { toInputSchema } = await import("#tools/schema.js");
  expect(await toInputSchema(tool!.inputSchema)["~standard"].validate(input)).toHaveProperty(
    "issues",
  );
  await expect(
    contextStorage.run(ctx, () => actions.execute(tool!.name, input, { callId: "invalid" })),
  ).rejects.toThrow("Invalid subscription input");
  expect(subscriber).not.toHaveBeenCalled();
  expect(handlers.size).toBe(0);
});

it.each([{ ttlMs: 1 }, { ttlMs: 120_000, expiresAt: null }])(
  "rejects invalid subscription input %j even when the provider schema cannot be validated",
  async (lifetime) => {
    eventSchema = { type: "object", properties: { project: { type: "provider-specific" } } };
    const [tool] = await contextStorage.run(ctx, () => actions.metadata());
    await expect(
      contextStorage.run(ctx, () =>
        actions.execute(
          tool!.name,
          { arguments: { project: "ABC" }, ...lifetime },
          { callId: "invalid" },
        ),
      ),
    ).rejects.toThrow("Invalid subscription input");
    expect(subscriber).not.toHaveBeenCalled();
    expect(handlers.size).toBe(0);
  },
);

it.each(["available", "filtered", "catalog unavailable", "connection unavailable"])(
  "returns subscription results through eve's connection tool entry with MCP %s",
  async (availability) => {
    connection = { ...connection, headers: { account: "alice" } };
    if (availability === "filtered")
      connection = {
        ...connection,
        tools: { allow: [] },
        toolCall: { providedArguments: { arguments: () => ({ project: "REMOTE_ONLY" }) } },
      };
    const registry = new ConnectionRegistryImpl([connection]);
    try {
      await contextStorage.run(ctx, async () => {
        const [tool] = await listToolMetadata(
          connection.connectionName,
          registry.getClient(connection.connectionName),
        );
        const execute = (name: string, input: unknown) =>
          connectionEntry(registry, connection, name).execute!(input, {
            toolCallId: name,
            messages: [],
          });
        const created = (await execute(tool!.name, {
          arguments: { project: "ABC" },
          ttlMs: TTL_MS,
        })) as { id: string };
        expect(created).toMatchObject({ subscriptionId: "sub_0", status: "active" });
        expect(requested[0]!.arguments).toEqual({ project: "ABC" });
        if (availability.includes("unavailable")) {
          if (availability === "connection unavailable") await registry.dispose();
          createClient.mockRejectedValue(new Error("MCP unavailable"));
        }
        vi.mocked(adapter.getSubscription).mockResolvedValue(saved.values().next().value!);
        expect(await execute("events_get_subscription", { id: created.id })).toMatchObject({
          id: created.id,
          subscriptionId: "sub_0",
        });
        if (availability.includes("unavailable")) {
          setUser("bob");
          await expect(execute("events_get_subscription", { id: created.id })).rejects.toThrow(
            "Unknown subscription",
          );
          setUser("alice");
        }
        expect(await execute("events_unsubscribe", { id: created.id })).toMatchObject({
          id: created.id,
          subscriptionId: "sub_0",
          status: "stopped",
        });
        expect(adapter.unsubscribe).toHaveBeenCalledWith(expect.objectContaining({ id: "sub_0" }));
        expect(retired.has(created.id)).toBe(true);
      });
    } finally {
      await registry.dispose();
    }
  },
);

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
async function watch(callId = "watch-1", ttlMs: number | null = TTL_MS) {
  return contextStorage.run(ctx, async () => {
    const tools = await actions.metadata();
    try {
      return (await actions.execute(
        tools[0]!.name,
        { arguments: { project: "ABC" }, ttlMs },
        { callId },
      )) as ManagedEventSubscription & { subscriptionId: string };
    } finally {
      // Deliveries run under the binding the watch's hook carries, not session state.
      initial = { ...initial, binding: [...handlers.values()].at(-1)?.binding };
    }
  });
}
/** The context a handler run starts with: its creator, never the current caller. */
function handlerContext(binding: EventBinding, bundle: unknown): Record<string, unknown> {
  const handler = new ContextContainer();
  handler.set(BundleKey, bundle as CompiledRuntimeAgentBundle);
  handler.set(AuthKey, binding.auth);
  handler.set(SessionIdKey, binding.sessionId);
  return serializeContext(handler);
}
function payload(): ConnectionEventPayload {
  const binding = initial.binding!;
  return {
    kind: "connection-event",
    connectionName: "issues",
    bindingId: binding.id,
    delivery: {
      version: 1,
      deliveryId: "delivery-1",
      subscriptionId: "sub_0",
      source: { type: "mcp", connectorId: "connector" },
      context: binding.request.context!,
      event: {
        eventId: "event-1",
        name: binding.request.name,
        timestamp: "2026-10-07T00:00:00Z",
        data: { issue: "ABC-1" },
        cursor: null,
      },
    },
  };
}
async function dispatch(message: ConnectionEventPayload) {
  await dispatchConnectionEventStep({
    serializedContext: initial.serializedContext,
    binding: initial.binding!,
    payload: message,
  });
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
    // The handler re-checks its binding against the deployed connection.
    (ctx.require(BundleKey).resolvedAgent.connections as ResolvedConnectionDefinition[])[0] =
      connection;
    actions = new ConnectionEventActions(connection, connection.experimental_events!, async () => ({
      account: ctx.require(AuthKey)!.principalId,
    }));
    const { id } = await watch();
    setUser("bob");
    const tools = await contextStorage.run(ctx, () => actions.metadata());
    expect(tools[0]!.description).toContain("bob.issue.created");
    for (const action of ["events_get_subscription", "events_unsubscribe"])
      await expect(
        contextStorage.run(ctx, () => actions.execute(action, { id }, { callId: action })),
      ).rejects.toThrow("Unknown subscription");
    expect(adapter.unsubscribe).not.toHaveBeenCalled();
    setUser("alice");
    await watch();
    expect(subscriber).toHaveBeenCalledTimes(1);
  },
);

it("rejects invalid event arguments before subscription and fixes destination/identity outside model input", async () => {
  await contextStorage.run(ctx, async () => {
    const [tool] = await actions.metadata();
    await expect(
      actions.execute(
        tool!.name,
        { arguments: { project: 42 }, ttlMs: TTL_MS },
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
  const binding: EventBinding = {
    ...initial.binding!,
    id: "lost",
    request: { ...initial.binding!.request, idempotencyKey: "lost" },
  };
  const context = handlerContext(binding, ctx.require(BundleKey));
  const subscribe = subscriber.getMockImplementation()!;
  // Connect creates the subscription, but its response never arrives.
  subscriber.mockImplementationOnce(async (input) => {
    await subscribe(input);
    throw new Error("The operation timed out.");
  });
  await expect(subscribeConnectionEvent(context, binding)).rejects.toThrow("timed out");
  expect(await subscribeConnectionEvent(context, binding)).toEqual({
    subscription: saved.get("lost"),
  });
});

it("fails the subscribe action with Connect's error, and a retry reuses its idempotency key", async () => {
  subscriber.mockRejectedValueOnce(new Error("MCP Events provider request failed."));
  await expect(watch()).rejects.toThrow("MCP Events provider request failed.");
  expect(handlers.size).toBe(0);
  // A retry of the same tool call subscribes again with the same idempotency key.
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
  const message = payload();
  // The binding id only finds the watch; the delivery must still match what it watches.
  for (const candidate of [
    { ...message, connectionName: "other" },
    {
      ...message,
      delivery: {
        ...message.delivery,
        event: { ...(message.delivery as { event: object }).event, name: "other.event" },
      },
    },
  ])
    await dispatch(candidate as ConnectionEventPayload);
  expect(callback).not.toHaveBeenCalled();
});

it("ends the watch after its terminated callback", async () => {
  await watch();
  initial = { ...initial, serializedContext: serializeContext(ctx) };
  const normal = payload();
  const { event: _event, ...envelope } = normal.delivery as Extract<
    typeof normal.delivery,
    { event: unknown }
  >;
  const message: ConnectionEventPayload = {
    ...normal,
    delivery: {
      ...envelope,
      control: { type: "terminated", error: { code: 1, message: "Ended" } },
    },
  };
  await dispatch(message);
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
    expect(await actions.execute("events_unsubscribe", { id }, { callId: "stop" })).toMatchObject({
      id,
      subscriptionId: "sub_0",
      status: "stopped",
    });
  });
  expect(retired.has(id)).toBe(true);
});

it("keeps a stopped watch reachable while Connect finishes cleanup", async () => {
  const { id } = await watch();
  const pending = {
    ...saved.values().next().value!,
    status: "stopped" as const,
    cleanupStatus: "pending" as const,
  };
  vi.mocked(adapter.unsubscribe).mockResolvedValue(pending);
  vi.mocked(adapter.getSubscription).mockResolvedValue(pending);
  await contextStorage.run(ctx, async () => {
    await actions.execute("events_unsubscribe", { id }, { callId: "stop" });
    expect(
      await actions.execute("events_get_subscription", { id }, { callId: "get" }),
    ).toMatchObject({
      id,
      cleanupStatus: "pending",
    });
    await actions.execute("events_unsubscribe", { id }, { callId: "stop-again" });
  });
  expect(adapter.unsubscribe).toHaveBeenCalledTimes(2);
});

it("keeps the handler when Connect fails to unsubscribe, so stop can be retried", async () => {
  const { id } = await watch();
  vi.mocked(adapter.unsubscribe).mockRejectedValueOnce(new Error("Connect unavailable"));
  await contextStorage.run(ctx, async () => {
    await expect(actions.execute("events_unsubscribe", { id }, { callId: "stop" })).rejects.toThrow(
      "Connect unavailable",
    );
    expect(retired.has(id)).toBe(false);
    expect(
      await actions.execute("events_unsubscribe", { id }, { callId: "stop-again" }),
    ).toMatchObject({ status: "stopped" });
  });
  expect(retired.has(id)).toBe(true);
});

it("records a gap before dispatch and keeps the subscription available for later events", async () => {
  await watch();
  initial = { ...initial, serializedContext: serializeContext(ctx) };
  const normal = payload();
  const { event: _event, ...envelope } = normal.delivery as Extract<
    typeof normal.delivery,
    { event: unknown }
  >;
  const message: ConnectionEventPayload = {
    ...normal,
    delivery: { ...envelope, control: { type: "gap", cursor: "cursor-2", truncated: true } },
  };
  await dispatch(message);
  expect(gap).toHaveBeenCalledTimes(1);
  const next = { ...normal, delivery: { ...normal.delivery, deliveryId: "next" } };
  await dispatch(next);
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
      const message = payload();
      const delivery = message.delivery;
      const tracedMessage: ConnectionEventPayload = {
        ...message,
        requestTraceContext: { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 },
        delivery:
          kind === "event"
            ? delivery
            : {
                version: delivery.version,
                subscriptionId: delivery.subscriptionId,
                deliveryId: delivery.deliveryId,
                source: delivery.source,
                context: delivery.context,
                ...(kind === "gap"
                  ? { control: { type: "gap" as const, cursor: null } }
                  : {
                      control: {
                        type: "terminated" as const,
                        error: { code: 1, message: "private" },
                      },
                    }),
              },
      };
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
    compiledArtifactsSource: ctx.require(BundleKey).compiledArtifactsSource,
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
  ctx.set(SessionTraceSeedKey, {
    traceId: "3".repeat(32),
    spanId: "4".repeat(16),
    traceFlags: 0,
    decision: { action: "record", recordInputs: false, recordOutputs: false },
  });
  initial = { ...initial, serializedContext: serializeContext(ctx) };
  const message = {
    ...payload(),
    requestTraceContext: { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 },
  };
  await dispatch(message);
  expect(callback).toHaveBeenCalledOnce();
  expect(tracing.exporter.getFinishedSpans()).toEqual([]);
});
