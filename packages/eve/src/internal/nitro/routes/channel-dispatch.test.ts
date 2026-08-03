import type { H3Event } from "nitro";
import {
  context as apiContext,
  propagation as apiPropagation,
  trace as apiTrace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { trace as vendoredTrace } from "#compiled/@opentelemetry/api/index.js";

import {
  CHANNEL_SENTINEL,
  type CompiledChannel,
  setChannelInstrumentationKind,
} from "#channel/compiled-channel.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import {
  getInstrumentationConfig,
  registerInstrumentationConfig,
} from "#harness/instrumentation-config.js";
import type { CancelTurnInput, DeliverInput, RunInput, Runtime } from "#channel/types.js";
import { readVercelProjectLink } from "#internal/vercel/project-link.js";
import type { RouteContext } from "#public/definitions/channel.js";
import { resolveVercelOidcCurrentProject } from "#runtime/governance/auth/vercel-oidc-project.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
import {
  dispatchChannelRequest,
  dispatchChannelWebSocketRequest,
} from "#internal/nitro/routes/channel-dispatch.js";
import { resolveNitroChannelRuntimeBundle } from "#internal/nitro/routes/runtime-stack.js";

vi.mock("#internal/nitro/routes/runtime-stack.js", () => ({
  resolveNitroChannelRuntimeBundle: vi.fn(),
}));

vi.mock("#internal/vercel/project-link.js", () => ({
  readVercelProjectLink: vi.fn(),
}));

const mockedResolveNitroChannelRuntimeBundle = vi.mocked(resolveNitroChannelRuntimeBundle);
const mockedReadVercelProjectLink = vi.mocked(readVercelProjectLink);
const runtime = {} as Runtime;
const DEVELOPMENT_ARTIFACTS_CONFIG = {
  appRoot: "/app/agent",
  devRuntimeArtifactsPointerPath: "/app/agent/.eve/dev-runtime/current.json",
  kind: "development",
  moduleMapLoaderPath: "/eve/src/internal/authored-module-map-loader.ts",
} as const;

function createRuntime(overrides: Partial<Runtime> = {}): Runtime {
  return {
    createSession: vi.fn(),
    dispatchContinuation: vi.fn(),
    dispatchSession: vi.fn(),
    getEventStream: vi.fn().mockResolvedValue(new ReadableStream()),
    getStreamTailIndex: vi.fn().mockResolvedValue(-1),
    resolveContinuation: vi.fn(),
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {
    promise,
    reject,
    resolve,
  };
}

function createEvent(input?: {
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly method?: string;
  readonly requestIp?: string;
  readonly url?: string;
  readonly waitUntil?: (task: Promise<unknown>) => void;
}): H3Event {
  const request = new Request(input?.url ?? "https://eve.test/slack", {
    body: input?.body,
    headers: input?.headers,
    method: input?.method ?? "GET",
  });
  Object.assign(request, {
    ip: input?.requestIp ?? "127.0.0.1",
  });

  return {
    context: {
      params: {},
    },
    req: request,
    waitUntil: input?.waitUntil,
  } as H3Event;
}

describe("dispatchChannelRequest", () => {
  it("supplies the current linked project to Vercel OIDC during local development", async () => {
    mockedReadVercelProjectLink
      .mockResolvedValueOnce({ orgId: "team_1", projectId: "prj_first" })
      .mockResolvedValueOnce({ orgId: "team_1", projectId: "prj_second" });
    const currentProjects: Array<Awaited<ReturnType<typeof resolveVercelOidcCurrentProject>>> = [];
    mockedResolveNitroChannelRuntimeBundle.mockResolvedValue({
      channels: [
        {
          handler: async (request) => {
            currentProjects.push(await resolveVercelOidcCurrentProject(request));
            return new Response("ok");
          },
          fetch: async () => new Response("not used"),
          logicalPath: "agent/channels/eve.ts",
          method: "POST",
          name: "eve",
          sourceId: "channel-eve",
          sourceKind: "module",
          urlPath: "/eve/v1/session",
        } satisfies ResolvedChannelDefinition,
      ],
      runtime,
    });

    const response = await dispatchChannelRequest(
      createEvent({ waitUntil: vi.fn() }),
      "POST /eve/v1/session",
      DEVELOPMENT_ARTIFACTS_CONFIG,
    );
    const nextResponse = await dispatchChannelRequest(
      createEvent({ waitUntil: vi.fn() }),
      "POST /eve/v1/session",
      DEVELOPMENT_ARTIFACTS_CONFIG,
    );

    expect(response.status).toBe(200);
    expect(nextResponse.status).toBe(200);
    expect(currentProjects).toEqual([
      { environment: "development", projectId: "prj_first" },
      { environment: "development", projectId: "prj_second" },
    ]);
  });

  it("returns the response before background work settles when Nitro provides waitUntil", async () => {
    const deferred = createDeferred<void>();
    const waitUntil = vi.fn<(task: Promise<unknown>) => void>();

    mockedResolveNitroChannelRuntimeBundle.mockResolvedValue({
      channels: [
        {
          fetch: async (_request: Request, ctx: { waitUntil: (t: Promise<unknown>) => void }) => {
            ctx.waitUntil(deferred.promise);
            return new Response("ok");
          },
          logicalPath: "agent/channels/slack.ts",
          method: "POST",
          name: "slack",
          sourceId: "channel-slack",
          sourceKind: "module",
          urlPath: "/slack",
        } satisfies ResolvedChannelDefinition,
      ],
      runtime,
    });

    const responsePromise = dispatchChannelRequest(
      createEvent({ waitUntil }),
      "POST /slack",
      {} as never,
    );

    await expect(
      Promise.race([
        responsePromise.then(() => "response"),
        deferred.promise.then(() => "background"),
      ]),
    ).resolves.toBe("response");
    expect(waitUntil).toHaveBeenCalledTimes(1);

    const backgroundWork = waitUntil.mock.calls[0]?.[0];
    expect(backgroundWork).toBeInstanceOf(Promise);

    deferred.resolve();
    await backgroundWork;

    const response = await responsePromise;
    await expect(response.text()).resolves.toBe("ok");
  });

  it("hands the route handler an args.receive() that hits another channel's receive", async () => {
    const targetReceive = vi.fn().mockResolvedValue({
      id: "sess_target",
      continuationToken: "tok",
      async getEventStream() {
        return new ReadableStream();
      },
      async getStreamTailIndex() {
        return -1;
      },
    });
    const targetDefinition: CompiledChannel = {
      __kind: CHANNEL_SENTINEL,
      routes: [],
      adapter: { kind: "channel:target" },
      receive: targetReceive,
    };

    let capturedArgs: RouteHandlerArgs | undefined;
    mockedResolveNitroChannelRuntimeBundle.mockResolvedValue({
      channels: [
        {
          handler: async (_req, args) => {
            capturedArgs = args;
            await args.receive(targetDefinition, {
              message: "handoff",
              target: { foo: "bar" },
              auth: {
                attributes: {},
                authenticator: "app",
                principalId: "p",
                principalType: "user",
              },
            });
            return new Response("ok");
          },
          fetch: async () => new Response("ok"),
          adapter: { kind: "channel:source" },
          logicalPath: "agent/channels/webhook.ts",
          method: "POST",
          name: "webhook",
          sourceId: "channel-webhook",
          sourceKind: "module",
          urlPath: "/webhook",
        } satisfies ResolvedChannelDefinition,
        {
          handler: async () => new Response("ok"),
          fetch: async () => new Response("ok"),
          adapter: { kind: "channel:target" },
          definition: targetDefinition,
          receive: targetReceive,
          logicalPath: "agent/channels/target.ts",
          method: "POST",
          name: "target",
          sourceId: "channel-target",
          sourceKind: "module",
          urlPath: "/target",
        } satisfies ResolvedChannelDefinition,
      ],
      runtime,
    });

    const response = await dispatchChannelRequest(
      createEvent({ waitUntil: vi.fn() }),
      "POST /webhook",
      {} as never,
    );

    expect(response.status).toBe(200);
    expect(typeof capturedArgs?.receive).toBe("function");
    expect(targetReceive).toHaveBeenCalledTimes(1);
    const [input, ctx] = targetReceive.mock.calls[0]!;
    expect(input.message).toBe("handoff");
    expect(input.target).toEqual({ foo: "bar" });
    expect(typeof ctx.send).toBe("function");
  });

  it("tags route sends with Vercel's request id", async () => {
    const runtimeForTest = createRuntime({
      dispatchContinuation: vi.fn().mockResolvedValue({
        sessionId: "sess_route",
        status: "accepted",
      }),
    });

    mockedResolveNitroChannelRuntimeBundle.mockResolvedValue({
      channels: [
        {
          handler: async (_req, args) => {
            await args.send("hello", {
              auth: null,
              continuationToken: "route-token",
            });
            return new Response("ok");
          },
          fetch: async () => new Response("ok"),
          adapter: { kind: "channel:webhook" },
          logicalPath: "agent/channels/webhook.ts",
          method: "POST",
          name: "webhook",
          sourceId: "channel-webhook",
          sourceKind: "module",
          urlPath: "/webhook",
        } satisfies ResolvedChannelDefinition,
      ],
      runtime: runtimeForTest,
    });

    const response = await dispatchChannelRequest(
      createEvent({
        headers: { "x-vercel-id": "iad1::abc123-1710000000000-deadbeef" },
        waitUntil: vi.fn(),
      }),
      "POST /webhook",
      {} as never,
    );

    expect(response.status).toBe(200);
    expect(vi.mocked(runtimeForTest.dispatchContinuation).mock.calls[0]?.[0].command).toMatchObject(
      { requestId: "iad1::abc123-1710000000000-deadbeef" },
    );
  });

  it("supplies a channel-scoped reset helper", async () => {
    const runtimeForTest = createRuntime({
      dispatchContinuation: vi.fn().mockResolvedValue({
        previousSessionId: "sess_previous",
        status: "reset",
      }),
    });

    mockedResolveNitroChannelRuntimeBundle.mockResolvedValue({
      channels: [
        {
          handler: async (_req, args) =>
            Response.json(
              await args.reset({
                continuationToken: "direct:+15551234567:+15557654321",
                reason: "User requested /new",
              }),
            ),
          fetch: async () => new Response("ok"),
          logicalPath: "agent/channels/imessage.ts",
          method: "POST",
          name: "imessage",
          sourceId: "channel-imessage",
          sourceKind: "module",
          urlPath: "/imessage",
        } satisfies ResolvedChannelDefinition,
      ],
      runtime: runtimeForTest,
    });

    const response = await dispatchChannelRequest(
      createEvent({ waitUntil: vi.fn() }),
      "POST /imessage",
      {} as never,
    );

    await expect(response.json()).resolves.toEqual({
      previousSessionId: "sess_previous",
      status: "reset",
    });
    expect(runtimeForTest.dispatchContinuation).toHaveBeenCalledWith({
      command: { kind: "reset", reason: "User requested /new" },
      continuationToken: "imessage:direct:+15551234567:+15557654321",
    });
  });

  it("supplies a channel-scoped clear helper", async () => {
    const runtimeForTest = createRuntime({
      dispatchContinuation: vi
        .fn()
        .mockResolvedValue({ sessionId: "sess_active", status: "accepted" }),
    });

    mockedResolveNitroChannelRuntimeBundle.mockResolvedValue({
      channels: [
        {
          handler: async (_req, args) =>
            Response.json(
              await args.clear({ continuationToken: "direct:+15551234567:+15557654321" }),
            ),
          fetch: async () => new Response("ok"),
          logicalPath: "agent/channels/imessage.ts",
          method: "POST",
          name: "imessage",
          sourceId: "channel-imessage",
          sourceKind: "module",
          urlPath: "/imessage",
        } satisfies ResolvedChannelDefinition,
      ],
      runtime: runtimeForTest,
    });

    const response = await dispatchChannelRequest(
      createEvent({ waitUntil: vi.fn() }),
      "POST /imessage",
      {} as never,
    );

    await expect(response.json()).resolves.toEqual({
      sessionId: "sess_active",
      status: "accepted",
    });
    expect(runtimeForTest.dispatchContinuation).toHaveBeenCalledWith({
      command: { kind: "clear" },
      continuationToken: "imessage:direct:+15551234567:+15557654321",
    });
  });

  it("does not invent a channel request id when Vercel did not send one", async () => {
    const runtimeForTest = createRuntime({
      dispatchContinuation: vi.fn().mockResolvedValue({
        sessionId: "sess_route",
        status: "accepted",
      }),
    });

    mockedResolveNitroChannelRuntimeBundle.mockResolvedValue({
      channels: [
        {
          handler: async (_req, args) => {
            await args.send("hello", {
              auth: null,
              continuationToken: "route-token",
            });
            return new Response("ok");
          },
          fetch: async () => new Response("ok"),
          adapter: { kind: "channel:webhook" },
          logicalPath: "agent/channels/webhook.ts",
          method: "POST",
          name: "webhook",
          sourceId: "channel-webhook",
          sourceKind: "module",
          urlPath: "/webhook",
        } satisfies ResolvedChannelDefinition,
      ],
      runtime: runtimeForTest,
    });

    const response = await dispatchChannelRequest(
      createEvent({ waitUntil: vi.fn() }),
      "POST /webhook",
      {} as never,
    );

    expect(response.status).toBe(200);
    expect(
      vi.mocked(runtimeForTest.dispatchContinuation).mock.calls[0]?.[0].command,
    ).toHaveProperty("requestId", undefined);
  });

  it("does not mutate route-owned run and deliver inputs", async () => {
    const runtimeForTest = createRuntime({
      createSession: vi.fn().mockResolvedValue({
        continuationToken: "route-token",
        events: new ReadableStream(),
        sessionId: "sess_run",
      }),
      dispatchContinuation: vi.fn().mockResolvedValue({
        sessionId: "sess_deliver",
        status: "accepted",
      }),
      dispatchSession: vi.fn().mockResolvedValue({ status: "accepted" }),
    });
    const deliverInput = Object.freeze({
      auth: null,
      continuationToken: "route-token",
      payload: { message: "follow up" },
    } satisfies DeliverInput);
    const runInput = Object.freeze({
      adapter: { kind: "channel:test" },
      auth: null,
      input: { message: "start" },
      mode: "conversation",
    } satisfies RunInput);
    const cancelInput = Object.freeze({
      sessionId: "sess_run",
      turnId: "turn_1",
    } satisfies CancelTurnInput);

    mockedResolveNitroChannelRuntimeBundle.mockResolvedValue({
      channels: [
        {
          fetch: async (_request: Request, ctx: RouteContext) => {
            await ctx.agent.cancelTurn(cancelInput);
            await ctx.agent.deliver(deliverInput);
            await ctx.agent.run(runInput);
            return new Response("ok");
          },
          logicalPath: "agent/channels/internal.ts",
          method: "POST",
          name: "internal",
          sourceId: "channel-internal",
          sourceKind: "module",
          urlPath: "/internal",
        } satisfies ResolvedChannelDefinition,
      ],
      runtime: runtimeForTest,
    });

    const response = await dispatchChannelRequest(
      createEvent({
        headers: { "x-vercel-id": "iad1::abc123-1710000000000-deadbeef" },
        waitUntil: vi.fn(),
      }),
      "POST /internal",
      {} as never,
    );

    expect(response.status).toBe(200);
    const deliveredInput = vi.mocked(runtimeForTest.dispatchContinuation).mock.calls[0]?.[0];
    const startedInput = vi.mocked(runtimeForTest.createSession).mock.calls[0]?.[0];
    expect(runtimeForTest.dispatchSession).toHaveBeenCalledWith({
      command: { kind: "cancel", turnId: "turn_1" },
      sessionId: "sess_run",
    });
    expect(deliveredInput).not.toBe(deliverInput);
    expect(startedInput).not.toBe(runInput);
    expect(deliveredInput?.command).toMatchObject({
      requestId: "iad1::abc123-1710000000000-deadbeef",
    });
    expect(startedInput?.requestId).toBe("iad1::abc123-1710000000000-deadbeef");
    expect(deliverInput).not.toHaveProperty("requestId");
    expect(runInput).not.toHaveProperty("requestId");
  });

  it("hands websocket route handlers the same route args", async () => {
    const waitUntil = vi.fn<(task: Promise<unknown>) => void>();
    let capturedArgs: RouteHandlerArgs | undefined;

    mockedResolveNitroChannelRuntimeBundle.mockResolvedValue({
      channels: [
        {
          fetch: async () => new Response("not used"),
          websocket: async (_req, args) => {
            capturedArgs = args;
            args.waitUntil(Promise.resolve());
            return {
              upgrade() {
                return { context: { ok: true } };
              },
            };
          },
          adapter: { kind: "channel:voice" },
          logicalPath: "agent/channels/voice.ts",
          method: "WEBSOCKET",
          name: "voice",
          sourceId: "channel-voice",
          sourceKind: "module",
          urlPath: "/voice",
        } satisfies ResolvedChannelDefinition,
      ],
      runtime,
    });

    const hooks = await dispatchChannelWebSocketRequest(
      createEvent({ requestIp: "203.0.113.4", waitUntil }),
      "WEBSOCKET /voice",
      {} as never,
    );

    await expect(
      Promise.resolve(hooks.upgrade?.(new Request("https://eve.test/voice"))),
    ).resolves.toEqual({
      context: { ok: true },
    });
    expect(capturedArgs?.requestIp).toBe("203.0.113.4");
    expect(typeof capturedArgs?.send).toBe("function");
    expect(typeof capturedArgs?.getSession).toBe("function");
    expect(typeof capturedArgs?.receive).toBe("function");
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("rejects websocket upgrades when no websocket channel matches", async () => {
    mockedResolveNitroChannelRuntimeBundle.mockResolvedValue({
      channels: [],
      runtime,
    });

    const hooks = await dispatchChannelWebSocketRequest(
      createEvent({ waitUntil: vi.fn() }),
      "WEBSOCKET /missing",
      {} as never,
    );

    let thrown: unknown;
    try {
      hooks.upgrade?.(new Request("https://eve.test/missing"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });

  it("logs and returns a 500 with an errorId when a handler throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedResolveNitroChannelRuntimeBundle.mockResolvedValue({
      channels: [
        {
          fetch: async () => {
            throw new Error("handler exploded");
          },
          logicalPath: "agent/channels/slack.ts",
          method: "POST",
          name: "slack",
          sourceId: "channel-slack",
          sourceKind: "module",
          urlPath: "/slack",
        } satisfies ResolvedChannelDefinition,
      ],
      runtime,
    });

    const response = await dispatchChannelRequest(
      createEvent({ waitUntil: vi.fn() }),
      "POST /slack",
      {} as never,
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as { ok: boolean; errorId: string };
    expect(body.ok).toBe(false);
    expect(typeof body.errorId).toBe("string");

    const logged = errorSpy.mock.calls.find(([line]) =>
      String(line).includes("channel handler threw"),
    );
    expect(logged).toBeDefined();
    expect(logged![1]).toMatchObject({ channel: "slack", error: { errorId: body.errorId } });
    errorSpy.mockRestore();
  });

  it("logs rejected background tasks instead of silently swallowing them", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let drained: Promise<unknown> | undefined;
    const waitUntil = vi.fn<(task: Promise<unknown>) => void>((task) => {
      drained = task;
    });

    mockedResolveNitroChannelRuntimeBundle.mockResolvedValue({
      channels: [
        {
          fetch: async (_req, ctx: { waitUntil: (t: Promise<unknown>) => void }) => {
            ctx.waitUntil(Promise.reject(new Error("background blew up")));
            return new Response("ok");
          },
          logicalPath: "agent/channels/slack.ts",
          method: "POST",
          name: "slack",
          sourceId: "channel-slack",
          sourceKind: "module",
          urlPath: "/slack",
        } satisfies ResolvedChannelDefinition,
      ],
      runtime,
    });

    const response = await dispatchChannelRequest(
      createEvent({ waitUntil }),
      "POST /slack",
      {} as never,
    );

    expect(await response.text()).toBe("ok");
    expect(drained).toBeInstanceOf(Promise);
    await drained;

    const logged = errorSpy.mock.calls.find(([line]) =>
      String(line).includes("channel background task failed"),
    );
    expect(logged).toBeDefined();
    expect(logged![1]).toMatchObject({ channel: "slack" });
    errorSpy.mockRestore();
  });

  it("does not call waitUntil when no background work is registered", async () => {
    const waitUntil = vi.fn<(task: Promise<unknown>) => void>();

    mockedResolveNitroChannelRuntimeBundle.mockResolvedValue({
      channels: [
        {
          fetch: async () => new Response("ok"),
          logicalPath: "agent/channels/slack.ts",
          method: "POST",
          name: "slack",
          sourceId: "channel-slack",
          sourceKind: "module",
          urlPath: "/slack",
        } satisfies ResolvedChannelDefinition,
      ],
      runtime,
    });

    const response = await dispatchChannelRequest(
      createEvent({ waitUntil }),
      "POST /slack",
      {} as never,
    );

    expect(waitUntil).not.toHaveBeenCalled();
    await expect(response.text()).resolves.toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Inbound HTTP tracing
//
// The vendored `#compiled/@opentelemetry/api` and the real `@opentelemetry/api`
// share one process-global registry (same major version), so a provider, the
// official `AsyncLocalStorageContextManager`, and a propagator registered
// through the real package are what the production code's vendored calls
// observe. That lets these unit tests assert real recording spans,
// active-context inheritance across awaits, and W3C extraction without a live
// exporter.
// ---------------------------------------------------------------------------

/** Minimal W3C `traceparent` extractor — enough to model an inbound trace context. */
const w3cPropagator = {
  fields: () => ["traceparent"],
  inject: () => {},
  extract(context: unknown, carrier: unknown, getter: { get(c: unknown, k: string): unknown }) {
    const raw = getter.get(carrier, "traceparent");
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string") {
      return context;
    }
    const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value);
    if (match === null) {
      return context;
    }
    return apiTrace.setSpanContext(context as never, {
      isRemote: true,
      spanId: match[2]!,
      traceFlags: parseInt(match[3]!, 16),
      traceId: match[1]!,
    });
  },
};

function parentSpanId(span: ReadableSpan): string | undefined {
  return (span as { parentSpanContext?: { spanId?: string } }).parentSpanContext?.spanId;
}

function slackChannel(
  fetch: ResolvedChannelDefinition["fetch"],
  overrides: Partial<ResolvedChannelDefinition> = {},
): ResolvedChannelDefinition {
  return {
    fetch,
    logicalPath: "agent/channels/slack.ts",
    method: "POST",
    name: "slack",
    sourceId: "channel-slack",
    sourceKind: "module",
    urlPath: "/slack",
    ...overrides,
  } satisfies ResolvedChannelDefinition;
}

describe("dispatchChannelRequest tracing", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let priorConfig: ReturnType<typeof getInstrumentationConfig>;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    apiContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    apiPropagation.setGlobalPropagator(w3cPropagator as never);
    apiTrace.setGlobalTracerProvider(provider);
    // Request spans are opt-in; enable them for this suite.
    priorConfig = getInstrumentationConfig();
    registerInstrumentationConfig({ traceChannelRequests: true }, { agentName: "test" });
  });

  afterEach(() => {
    registerInstrumentationConfig(priorConfig ?? {}, { agentName: "test" });
    apiTrace.disable();
    apiContext.disable();
    apiPropagation.disable();
  });

  async function finishedSpans(): Promise<ReadableSpan[]> {
    await provider.forceFlush();
    return exporter.getFinishedSpans();
  }

  it("emits one SERVER span named for the route with method, channel, and status attributes", async () => {
    let spansDuringHandler = -1;
    mockedResolveNitroChannelRuntimeBundle.mockResolvedValue({
      channels: [
        slackChannel(
          async () => {
            spansDuringHandler = exporter.getFinishedSpans().length;
            return new Response("ok");
          },
          { adapter: { kind: "channel:slack" } },
        ),
      ],
      runtime,
    });

    const response = await dispatchChannelRequest(
      createEvent({ method: "POST", waitUntil: vi.fn() }),
      "POST /slack",
      {} as never,
    );

    expect(response.status).toBe(200);
    // The span had not ended while the handler was still running.
    expect(spansDuringHandler).toBe(0);

    const spans = await finishedSpans();
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span!.name).toBe("POST /slack");
    expect(span!.kind).toBe(1 /* SpanKind.SERVER */);
    expect(span!.attributes).toMatchObject({
      "eve.channel.kind": "channel:slack",
      "eve.channel.name": "slack",
      "http.request.method": "POST",
      "http.response.status_code": 200,
      "http.route": "/slack",
      "server.address": "eve.test",
      "url.scheme": "https",
    });
    expect(span!.status.code).toBe(0 /* SpanStatusCode.UNSET */);
  });

  it("stamps the instrumentation kind for a behaviorless authored channel, not the http adapter kind", async () => {
    // Behaviorless authored channels keep adapter kind "http"; the stamped
    // instrumentation kind carries the real channel:<name>.
    const definition: CompiledChannel = {
      __kind: CHANNEL_SENTINEL,
      routes: [],
      adapter: { kind: "http" },
    };
    setChannelInstrumentationKind(definition, "channel:support");

    mockedResolveNitroChannelRuntimeBundle.mockResolvedValue({
      channels: [
        slackChannel(async () => new Response("ok"), {
          adapter: { kind: "http" },
          definition,
        }),
      ],
      runtime,
    });

    await dispatchChannelRequest(createEvent({ waitUntil: vi.fn() }), "POST /slack", {} as never);

    const [span] = await finishedSpans();
    expect(span!.attributes["eve.channel.kind"]).toBe("channel:support");
  });

  it("makes a span created inside the handler a child of the request span", async () => {
    mockedResolveNitroChannelRuntimeBundle.mockResolvedValue({
      channels: [
        slackChannel(async () => {
          // Model hook.resume: a nested span opened under the active context.
          await Promise.resolve();
          vendoredTrace.getTracer("test.nested").startSpan("hook.resume").end();
          return new Response("ok");
        }),
      ],
      runtime,
    });

    await dispatchChannelRequest(createEvent({ waitUntil: vi.fn() }), "POST /slack", {} as never);

    const spans = await finishedSpans();
    const server = spans.find((span) => span.name === "POST /slack");
    const nested = spans.find((span) => span.name === "hook.resume");
    expect(server).toBeDefined();
    expect(nested).toBeDefined();
    expect(nested!.spanContext().traceId).toBe(server!.spanContext().traceId);
    expect(parentSpanId(nested!)).toBe(server!.spanContext().spanId);
  });

  it("adopts an incoming traceparent as the request span's parent", async () => {
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    const parentId = "b7ad6b7169203331";
    mockedResolveNitroChannelRuntimeBundle.mockResolvedValue({
      channels: [slackChannel(async () => new Response("ok"))],
      runtime,
    });

    await dispatchChannelRequest(
      createEvent({
        headers: { traceparent: `00-${traceId}-${parentId}-01` },
        waitUntil: vi.fn(),
      }),
      "POST /slack",
      {} as never,
    );

    const [span] = await finishedSpans();
    expect(span!.spanContext().traceId).toBe(traceId);
    expect(parentSpanId(span!)).toBe(parentId);
  });

  it("marks the span an error and records the exception once for a handler that throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedResolveNitroChannelRuntimeBundle.mockResolvedValue({
      channels: [
        slackChannel(async () => {
          throw new Error("handler exploded");
        }),
      ],
      runtime,
    });

    const response = await dispatchChannelRequest(
      createEvent({ waitUntil: vi.fn() }),
      "POST /slack",
      {} as never,
    );

    // The existing JSON 500 conversion is unchanged.
    expect(response.status).toBe(500);
    const body = (await response.json()) as { errorId: string; ok: boolean };
    expect(body.ok).toBe(false);
    expect(typeof body.errorId).toBe("string");

    const [span] = await finishedSpans();
    expect(span!.attributes["http.response.status_code"]).toBe(500);
    expect(span!.status.code).toBe(2 /* SpanStatusCode.ERROR */);
    const exceptions = span!.events.filter((event) => event.name === "exception");
    expect(exceptions).toHaveLength(1);
    errorSpy.mockRestore();
  });

  it("records the exception and rethrows when runtime-bundle resolution fails", async () => {
    mockedResolveNitroChannelRuntimeBundle.mockRejectedValue(new Error("bundle boom"));

    await expect(
      dispatchChannelRequest(createEvent({ waitUntil: vi.fn() }), "POST /slack", {} as never),
    ).rejects.toThrow("bundle boom");

    const [span] = await finishedSpans();
    expect(span!.name).toBe("POST /slack");
    expect(span!.status.code).toBe(2 /* SpanStatusCode.ERROR */);
    expect(span!.events.filter((event) => event.name === "exception")).toHaveLength(1);
    // No channel was resolved, so no channel identity is attached.
    expect(span!.attributes["eve.channel.name"]).toBeUndefined();
  });

  it("still emits a 404 span with the route but no channel identity when nothing matches", async () => {
    mockedResolveNitroChannelRuntimeBundle.mockResolvedValue({ channels: [], runtime });

    const response = await dispatchChannelRequest(
      createEvent({ waitUntil: vi.fn() }),
      "POST /missing",
      {} as never,
    );

    expect(response.status).toBe(404);

    const [span] = await finishedSpans();
    expect(span!.name).toBe("POST /missing");
    expect(span!.attributes["http.response.status_code"]).toBe(404);
    expect(span!.attributes["http.route"]).toBe("/missing");
    expect(span!.attributes["eve.channel.name"]).toBeUndefined();
    expect(span!.status.code).toBe(0 /* SpanStatusCode.UNSET */);
  });

  it("keeps session ids, tokens, auth headers, bodies, and query strings off the span", async () => {
    const sessionId = "sess_secret123";
    const hookToken = "hooktoken_secret";
    const authSecret = "bearer_authsecret";
    const bodySecret = "body_payload_secret";

    mockedResolveNitroChannelRuntimeBundle.mockResolvedValue({
      channels: [
        {
          fetch: async () => new Response("ok"),
          logicalPath: "agent/channels/eve.ts",
          method: "POST",
          name: "eve",
          sourceId: "channel-eve",
          sourceKind: "module",
          urlPath: "/eve/v1/session/:sessionId",
        } satisfies ResolvedChannelDefinition,
      ],
      runtime,
    });

    const event = createEvent({
      body: bodySecret,
      headers: { authorization: authSecret, cookie: "eve_session=cookiesecret" },
      method: "POST",
      url: `https://eve.test/eve/v1/session/${sessionId}?token=${hookToken}`,
    });

    await dispatchChannelRequest(event, "POST /eve/v1/session/:sessionId", {} as never);

    const [span] = await finishedSpans();
    expect(span!.name).toBe("POST /eve/v1/session/:sessionId");
    const serialized = JSON.stringify({
      attributes: span!.attributes,
      events: span!.events,
      name: span!.name,
      status: span!.status,
    });
    for (const secret of [sessionId, hookToken, authSecret, bodySecret, "cookiesecret"]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe("dispatchChannelRequest without an OTel provider", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let priorConfig: ReturnType<typeof getInstrumentationConfig>;

  beforeEach(() => {
    // Register an exporter to prove nothing reaches it, but leave the global
    // tracer provider as the no-op default. Enable the opt-in flag so this
    // exercises the no-provider path rather than the disabled-flag bypass.
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    apiTrace.disable();
    apiContext.disable();
    apiPropagation.disable();
    priorConfig = getInstrumentationConfig();
    registerInstrumentationConfig({ traceChannelRequests: true }, { agentName: "test" });
  });

  afterEach(() => {
    registerInstrumentationConfig(priorConfig ?? {}, { agentName: "test" });
    apiTrace.disable();
  });

  it("handles the request identically and records no spans", async () => {
    const waitUntil = vi.fn<(task: Promise<unknown>) => void>();
    mockedResolveNitroChannelRuntimeBundle.mockResolvedValue({
      channels: [slackChannel(async () => new Response("ok"))],
      runtime,
    });

    const response = await dispatchChannelRequest(
      createEvent({ waitUntil }),
      "POST /slack",
      {} as never,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
    await provider.forceFlush();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe("dispatchChannelRequest with request tracing not enabled", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let priorConfig: ReturnType<typeof getInstrumentationConfig>;

  beforeEach(() => {
    // A live provider proves the opt-in flag — not a missing provider — is what
    // gates the span.
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    apiContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    apiPropagation.setGlobalPropagator(w3cPropagator as never);
    apiTrace.setGlobalTracerProvider(provider);
    priorConfig = getInstrumentationConfig();
  });

  afterEach(() => {
    // Restore the process-global config so the toggle does not leak.
    registerInstrumentationConfig(priorConfig ?? {}, { agentName: "test" });
    apiTrace.disable();
    apiContext.disable();
    apiPropagation.disable();
  });

  async function expectNoSpan(): Promise<void> {
    const waitUntil = vi.fn<(task: Promise<unknown>) => void>();
    mockedResolveNitroChannelRuntimeBundle.mockResolvedValue({
      channels: [slackChannel(async () => new Response("ok"))],
      runtime,
    });

    const response = await dispatchChannelRequest(
      createEvent({ waitUntil }),
      "POST /slack",
      {} as never,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
    await provider.forceFlush();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  }

  it("emits no request span by default when the flag is unset", async () => {
    registerInstrumentationConfig({}, { agentName: "test" });
    await expectNoSpan();
  });

  it("emits no request span when the flag is explicitly false", async () => {
    registerInstrumentationConfig({ traceChannelRequests: false }, { agentName: "test" });
    await expectNoSpan();
  });
});
