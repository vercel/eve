import type { H3Event } from "nitro";
import { describe, expect, it, vi } from "vitest";

import { CHANNEL_SENTINEL, type CompiledChannel } from "#channel/compiled-channel.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
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
  readonly headers?: Record<string, string>;
  readonly requestIp?: string;
  readonly waitUntil?: (task: Promise<unknown>) => void;
}): H3Event {
  const request = new Request("https://eve.test/slack", { headers: input?.headers });
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
    const runtimeForTest: Runtime = {
      cancelTurn: vi.fn(),
      deliver: vi.fn().mockResolvedValue({ sessionId: "sess_route" }),
      resolveSession: vi.fn(),
      getEventStream: vi.fn().mockResolvedValue(new ReadableStream()),
      run: vi.fn(),
    };

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
    expect(vi.mocked(runtimeForTest.deliver).mock.calls[0]?.[0].requestId).toBe(
      "iad1::abc123-1710000000000-deadbeef",
    );
  });

  it("does not invent a channel request id when Vercel did not send one", async () => {
    const runtimeForTest: Runtime = {
      cancelTurn: vi.fn(),
      deliver: vi.fn().mockResolvedValue({ sessionId: "sess_route" }),
      resolveSession: vi.fn(),
      getEventStream: vi.fn().mockResolvedValue(new ReadableStream()),
      run: vi.fn(),
    };

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
    expect(vi.mocked(runtimeForTest.deliver).mock.calls[0]?.[0].requestId).toBeUndefined();
  });

  it("does not mutate route-owned run and deliver inputs", async () => {
    const runtimeForTest: Runtime = {
      cancelTurn: vi.fn().mockResolvedValue({ status: "accepted" }),
      deliver: vi.fn().mockResolvedValue({ sessionId: "sess_deliver" }),
      resolveSession: vi.fn(),
      getEventStream: vi.fn().mockResolvedValue(new ReadableStream()),
      run: vi.fn().mockResolvedValue({
        continuationToken: "route-token",
        events: new ReadableStream(),
        sessionId: "sess_run",
      }),
    };
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
    const deliveredInput = vi.mocked(runtimeForTest.deliver).mock.calls[0]?.[0];
    const startedInput = vi.mocked(runtimeForTest.run).mock.calls[0]?.[0];
    expect(runtimeForTest.cancelTurn).toHaveBeenCalledWith(cancelInput);
    expect(deliveredInput).not.toBe(deliverInput);
    expect(startedInput).not.toBe(runInput);
    expect(deliveredInput?.requestId).toBe("iad1::abc123-1710000000000-deadbeef");
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
