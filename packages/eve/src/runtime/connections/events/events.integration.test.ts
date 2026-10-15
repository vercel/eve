import * as workflowRuntime from "#execution/workflow-runtime.js";
import { inMemory } from "#public/memory/file/backends/in-memory.js";
import { connectionEventStore } from "#runtime/connections/events/store.js";
import { principalKey, resolveConnectionPrincipal } from "#runtime/connections/principal.js";
import { principalOf } from "#execution/session/principal.js";
import { connectionEventHookToken } from "#runtime/connections/events/workflow.js";
import { start, resumeHook } from "#internal/workflow/runtime.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
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
import { defineState } from "#public/definitions/state.js";
import { AuthKey, SessionIdKey, SessionTraceSeedKey } from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { ConnectionEventActions } from "#runtime/connections/events/actions.js";
import type { ConnectionEventHandlerState } from "#runtime/connections/events/state.js";
import {
  prepareConnectionEventStep,
  dispatchConnectionEventStep,
} from "#runtime/connections/events/dispatch-step.js";
import type { ConnectionEventPayload } from "#runtime/connections/events/delivery.js";
import { listToolMetadata } from "#execution/catalog/connection-auth.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type {
  ConnectionEventsAdapter,
  ManagedEventSubscribeInput,
  ManagedEventSubscription,
} from "#shared/connection-events.js";

const { createClient, loadBundle } = vi.hoisted(() => ({
  createClient: vi.fn(),
  loadBundle: vi.fn(),
}));
vi.mock("#compiled/@ai-sdk/mcp/index.js", () => ({ createMCPClient: createClient }));
vi.mock("#runtime/connections/events/owner.js", () => ({
  startConnectionEventOwner: vi.fn(async () => {}),
  retireConnectionEventOwner: vi.fn(async () => {}),
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
  state: ConnectionEventHandlerState | undefined;
};
let eventSchema: Record<string, unknown>;
const callbackState = defineState("events-test.receipts", () => [] as string[]);

beforeEach(async () => {
  eventSchema = {
    type: "object",
    properties: { project: { type: "string" } },
    required: ["project"],
    additionalProperties: false,
  };
  requested = [];
  saved = new Map();
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
    experimental_events: {
      storage: inMemory(),
      onEvent: callback,
      onGap: gap,
      onTerminated: terminated,
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
            experimental_events: connection.experimental_events,
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
    experimental_events:
      config.experimental_events === undefined
        ? undefined
        : {
            ...config.experimental_events.adapter.createAdapter({ transport: config.transport }),
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
  actions = new ConnectionEventActions(connection, async () => ({
    account: ctx.require(AuthKey)!.principalId,
  }));
  initial = {
    serializedContext: {},
    state: undefined,
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

it("discovers through the released AI SDK and subscribes through the backend without an event store", async () => {
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
    async () => ({ Authorization: "Bearer test" }),
    transportFetch,
  );
  await watch();
  expect(methods.filter((method) => method === "events/list")).toHaveLength(2);
  expect(methods).not.toContain("events/subscribe");
  const catalogSpans = tracing.exporter
    .getFinishedSpans()
    .filter((span) => span.name === "events/list");
  expect(catalogSpans).toHaveLength(2);
  expect(traceparents).toEqual(
    catalogSpans.map((span) => `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`),
  );
  expect(catalogSpans.map((span) => span.attributes["mcp.method.name"])).toEqual([
    "events/list",
    "events/list",
  ]);
  expect(
    tracing.exporter
      .getFinishedSpans()
      .find((span) => span.name === "agent.connection.event.subscribe")?.attributes,
  ).toMatchObject({ "connect.subscription.id": "sub_0", "connect.subscription.status": "active" });
  expect(subscriber).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ name: "issue.created", arguments: { project: "ABC" } }),
  );
  const authorization = connection.authorization;
  if (authorization === undefined || typeof authorization === "function")
    throw new Error("Static auth required");
  const bindings = await connectionEventStore(connection, {
    principalKey: principalKey(
      resolveConnectionPrincipal(connection.connectionName, authorization, ctx),
    ),
    executionPrincipal: principalOf(ctx.get(AuthKey)),
  }).list();
  expect(Object.values(bindings)[0]?.subscription?.id).toBe("sub_0");
});

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
        expect(
          await execute(tool!.name, { arguments: { project: "ABC" }, expiresAt: null }),
        ).toMatchObject({
          id: "sub_0",
          status: "active",
          retired: false,
        });
        expect(requested[0]!.arguments).toEqual({ project: "ABC" });
        expect(await execute("events_list_subscriptions", {})).toMatchObject({
          subscriptions: [{ id: "sub_0" }],
        });
        if (availability.includes("unavailable")) {
          if (availability === "connection unavailable") await registry.dispose();
          createClient.mockRejectedValue(new Error("MCP unavailable"));
        }
        vi.mocked(adapter.getSubscription).mockResolvedValue(saved.values().next().value!);
        expect(await execute("events_get_subscription", { id: "sub_0" })).toMatchObject({
          id: "sub_0",
        });
        expect(await execute("events_unsubscribe", { id: "sub_0" })).toMatchObject({
          id: "sub_0",
          status: "stopped",
          retired: true,
        });
        if (availability.includes("unavailable")) {
          setUser("bob");
          expect(await execute("events_list_subscriptions", {})).toEqual({ subscriptions: [] });
        }
      });
    } finally {
      await registry.dispose();
    }
  },
);

it("runs callbacks in the creator's eve context and persists authored state without changing the current caller", async () => {
  await watch();
  setUser("bob");
  initial = { ...initial, serializedContext: serializeContext(ctx) };
  callback.mockImplementation(async () => {
    expect(loadContext().require(AuthKey)?.principalId).toBe("alice");
    callbackState.update((receipts) => [...receipts, "received"]);
  });
  await prepare(payload());
  await dispatch(payload());
  expect(initial.serializedContext["events-test.receipts"]).toEqual(["received"]);
  expect(initial.serializedContext[AuthKey.name]).toMatchObject({ principalId: "bob" });
});

it("uses eve tool schema defaults and treats format as an annotation for event arguments", async () => {
  eventSchema = {
    type: "object",
    properties: {
      project: { type: "string", format: "email" },
      includeArchived: { type: "boolean", default: false },
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
async function watch(callId = "watch-1") {
  return contextStorage.run(ctx, async () => {
    const tools = await actions.metadata();
    const authorization = connection.authorization;
    if (authorization === undefined || typeof authorization === "function")
      throw new Error("Static auth required");
    try {
      return await actions.execute(
        tools[0]!.name,
        { arguments: { project: "ABC" }, expiresAt: null },
        { callId },
      );
    } finally {
      // Build the handler context from the durable registry, not session state.
      const owner = principalKey(
        resolveConnectionPrincipal(connection.connectionName, authorization, ctx),
      );
      const store = connectionEventStore(connection, {
        principalKey: owner,
        executionPrincipal: principalOf(ctx.get(AuthKey)),
      });
      const binding = Object.values(await store.list())[0];
      initial = {
        ...initial,
        state: binding === undefined ? undefined : { binding, receipts: {} },
      };
    }
  });
}
function payload(): ConnectionEventPayload {
  const binding = initial.state!.binding;
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
async function prepare(message: ConnectionEventPayload) {
  const result = await prepareConnectionEventStep({
    ...initial,
    state: initial.state!,
    payload: message,
  });
  initial = {
    ...initial,
    serializedContext: result.serializedContext,
    state: result.state,
  };
  return result;
}
async function dispatch(message: ConnectionEventPayload) {
  const result = await dispatchConnectionEventStep({
    ...initial,
    state: initial.state!,
    payload: message,
  });
  initial = {
    ...initial,
    serializedContext: result.serializedContext,
    state: result.state,
  };
}

it.each(["user", "app"] as const)(
  "isolates subscription management between users sharing a %s credential",
  async (principalType) => {
    const auth = connection.authorization;
    if (auth === undefined || typeof auth === "function") throw new Error("Missing fixture auth");
    connection = {
      ...connection,
      authorization: { principalType, getToken: auth.getToken, vercelConnect: auth.vercelConnect },
    };
    actions = new ConnectionEventActions(connection, async () => ({
      account: ctx.require(AuthKey)!.principalId,
    }));
    await watch();
    setUser("bob");
    const tools = await contextStorage.run(ctx, () => actions.metadata());
    expect(tools[0]!.description).toContain("bob.issue.created");
    await expect(
      contextStorage.run(ctx, () =>
        actions.execute("events_get_subscription", { id: "sub_0" }, { callId: "get" }),
      ),
    ).rejects.toThrow("Unknown subscription");
    expect(
      await contextStorage.run(ctx, () =>
        actions.execute("events_list_subscriptions", {}, { callId: "list" }),
      ),
    ).toEqual({ subscriptions: [] });
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
        { arguments: { project: 42 }, expiresAt: null },
        { callId: "invalid" },
      ),
    ).rejects.toThrow("catalog schema");
  });
  expect(subscriber).not.toHaveBeenCalled();
  await watch();
  expect(requested[0]!.context).toMatchObject({ eve: { version: 1, sessionId: "session-1" } });
});

it("reconciles an accepted subscribe with a lost response before dispatching and binds the original auth", async () => {
  const acceptedSubscribe = subscriber.getMockImplementation()!;
  subscriber.mockImplementationOnce(async (input) => {
    await acceptedSubscribe(input);
    throw new Error("response lost");
  });
  await expect(watch()).rejects.toThrow("response lost");
  const message = payload();
  setUser("bob");
  initial = { ...initial, serializedContext: serializeContext(ctx) };
  expect((await prepare(message)).accepted).toBe(true);
  expect(subscriber).toHaveBeenCalledTimes(2);
  expect(requested[0]!.idempotencyKey).toBe(requested[1]!.idempotencyKey);
  await dispatch(message);
  expect(callback).toHaveBeenCalledWith(
    expect.objectContaining({
      auth: expect.objectContaining({ principalId: "alice" }),
      origin: { sessionId: "session-1", connectionName: "issues", subscriptionId: "sub_0" },
    }),
  );
  expect((await prepare(message)).accepted).toBe(false);
  expect(callback).toHaveBeenCalledTimes(1);
});

it("does not authorize delivery based on its context, connection name, or event name alone", async () => {
  await watch();
  initial = { ...initial, serializedContext: serializeContext(ctx) };
  const message = payload();
  for (const candidate of [
    { ...message, bindingId: "unknown" },
    { ...message, connectionName: "other" },
    { ...message, delivery: { ...message.delivery, subscriptionId: "another-subscription" } },
    {
      ...message,
      delivery: {
        ...message.delivery,
        event: { ...(message.delivery as { event: object }).event, name: "other.event" },
      },
    },
  ])
    expect((await prepare(candidate as ConnectionEventPayload)).accepted).toBe(false);
  expect(callback).not.toHaveBeenCalled();
});

it("persists termination before its callback and does not execute later normal events", async () => {
  expect(await watch()).toMatchObject({ id: "sub_0", status: "active", retired: false });
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
  expect((await prepare(message)).accepted).toBe(true);
  expect(initial.state!.binding.retired).toBe(true);
  await dispatch(message);
  expect(terminated).toHaveBeenCalledTimes(1);
  expect(
    (await prepare({ ...normal, delivery: { ...normal.delivery, deliveryId: "next" } })).accepted,
  ).toBe(false);
  expect(callback).not.toHaveBeenCalled();
  ctx = await deserializeContext(initial.serializedContext);
  vi.mocked(adapter.getSubscription).mockResolvedValue(saved.values().next().value!);
  await contextStorage.run(ctx, async () => {
    const expected = { id: "sub_0", status: "active", retired: true };
    expect(
      await actions.execute("events_list_subscriptions", {}, { callId: "list" }),
    ).toMatchObject({
      subscriptions: [expected],
    });
    expect(
      await actions.execute("events_get_subscription", { id: "sub_0" }, { callId: "get" }),
    ).toMatchObject(expected);
    expect(
      await actions.execute("events_list_subscriptions", {}, { callId: "list-again" }),
    ).toMatchObject({
      subscriptions: [expected],
    });
  });
});

it("keeps failed callbacks pending for durable retry and prevents a duplicate successful dispatch", async () => {
  await watch();
  initial = { ...initial, serializedContext: serializeContext(ctx) };
  const message = payload();
  await prepare(message);
  callback.mockRejectedValueOnce(new Error("temporary failure"));
  await expect(dispatch(message)).rejects.toThrow("temporary failure");
  await dispatch(message);
  await dispatch(message);
  expect(callback).toHaveBeenCalledTimes(2);
});

it("retries termination after losing the registry write response without accepting new deliveries", async () => {
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
  const storage = connection.experimental_events!.storage!;
  const write = storage.write.bind(storage);
  vi.spyOn(storage, "write").mockImplementationOnce(async (input) => {
    await write(input);
    throw new Error("registry write response lost");
  });
  await expect(prepare(message)).rejects.toThrow("registry write response lost");
  // A retry starts with the previous step's state, without its pending receipt.
  expect((await prepare(normal)).accepted).toBe(false);
  expect(
    (
      await prepare({
        ...message,
        delivery: { ...message.delivery, deliveryId: "another-termination" },
      })
    ).accepted,
  ).toBe(false);
  expect((await prepare(message)).accepted).toBe(true);
  await dispatch(message);
  expect(terminated).toHaveBeenCalledTimes(1);
  expect((await prepare(message)).accepted).toBe(false);
});

it("registers and retires a durable event handler without a conversation session", async () => {
  await watch();
  const bindingId = crypto.randomUUID();
  const binding = { ...initial.state!.binding, id: bindingId };
  const run = await start(workflowRuntime.connectionEventWorkflowReference, [
    { binding, serializedContext: {} },
  ]);
  try {
    await waitForHook(run, { token: connectionEventHookToken(bindingId), timeout: 10_000 });
    await resumeHook(connectionEventHookToken(bindingId), { kind: "retire" });
    await run.returnValue;
    expect(callback).not.toHaveBeenCalled();
  } finally {
    await run.cancel().catch(() => {});
  }
});

it("lets the creator manage a watch from a later session without copying subscription state", async () => {
  await watch();
  ctx.set(SessionIdKey, "session-2");
  await contextStorage.run(ctx, async () => {
    expect(
      await actions.execute("events_list_subscriptions", {}, { callId: "list" }),
    ).toMatchObject({ subscriptions: [{ id: "sub_0", retired: false }] });
    expect(
      await actions.execute("events_unsubscribe", { id: "sub_0" }, { callId: "stop" }),
    ).toMatchObject({ id: "sub_0", retired: true, status: "stopped" });
  });
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
  expect((await prepare(message)).accepted).toBe(true);
  expect(initial.state!.binding.gap?.cursor).toBe("cursor-2");
  await dispatch(message);
  expect(gap).toHaveBeenCalledTimes(1);
  const next = { ...normal, delivery: { ...normal.delivery, deliveryId: "next" } };
  expect((await prepare(next)).accepted).toBe(true);
  await dispatch(next);
  expect(callback).toHaveBeenCalledTimes(1);
});

it("does not reactivate a retired binding when a concurrent status refresh finishes later", async () => {
  await watch();
  let finishGet!: (subscription: ManagedEventSubscription) => void;
  let getStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    getStarted = resolve;
  });
  vi.mocked(adapter.getSubscription).mockImplementationOnce(() => {
    getStarted();
    return new Promise((resolve) => {
      finishGet = resolve;
    });
  });
  await contextStorage.run(ctx, async () => {
    const refreshing = actions.execute(
      "events_get_subscription",
      { id: "sub_0" },
      { callId: "get" },
    );
    await started;
    await actions.execute("events_unsubscribe", { id: "sub_0" }, { callId: "stop" });
    finishGet(saved.values().next().value!);
    expect(await refreshing).toMatchObject({ retired: true });
  });
  initial = { ...initial, serializedContext: serializeContext(ctx) };
  expect((await prepare(payload())).accepted).toBe(false);
  expect(callback).not.toHaveBeenCalled();
});

it("can stop an uncertain creation by its local ID without contacting the MCP server", async () => {
  const accepted = subscriber.getMockImplementation()!;
  subscriber.mockImplementationOnce(async (input) => {
    await accepted(input);
    throw new Error("response lost");
  });
  await expect(watch()).rejects.toThrow("response lost");
  const binding = initial.state!.binding;
  createClient.mockRejectedValue(new Error("MCP unavailable"));
  const result = await contextStorage.run(ctx, () =>
    actions.execute("events_unsubscribe", { id: binding.id }, { callId: "stop" }),
  );
  expect(result).toMatchObject({ id: "sub_0", status: "stopped" });
  expect(requested[1]!.idempotencyKey).toBe(requested[0]!.idempotencyKey);
  initial = { ...initial, serializedContext: serializeContext(ctx) };
  expect((await prepare(payload())).accepted).toBe(false);
});

it("bounds completed delivery history while retaining pending receipts", async () => {
  await watch();
  const state = initial.state!;
  initial = {
    ...initial,
    state: {
      ...state,
      receipts: {
        ...Object.fromEntries(
          Array.from({ length: 1000 }, (_, i) => [`old-${i}`, "complete" as const]),
        ),
        waiting: "pending",
      },
    },
  };
  initial = { ...initial, serializedContext: serializeContext(ctx) };
  await prepare(payload());
  await dispatch(payload());
  const next = initial.state!;
  expect(Object.values(next.receipts).filter((status) => status === "complete")).toHaveLength(1000);
  expect(next.receipts.waiting).toBe("pending");
  expect(next.receipts["old-0"]).toBeUndefined();
  expect(next.receipts["delivery-1"]).toBe("complete");
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
      await prepare(tracedMessage);
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
      await prepare(payload());
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
      NonNullable<typeof connection.experimental_events>["onEvent"]
    >[0];
    await event
      .attachSession(event.origin.sessionId)
      .send("check this event", { auth: event.auth });
  });
  await prepare(payload());
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
  await prepare(message);
  await dispatch(message);
  expect(callback).toHaveBeenCalledOnce();
  expect(tracing.exporter.getFinishedSpans()).toEqual([]);
});
