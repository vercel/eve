import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { World } from "#compiled/@workflow/world/index.js";
import { createWorld, createWorldHubWorld, getWorldHubStats } from "./index.js";
import {
  createWorldHubServer,
  createWorldHubDispatcher,
  signWorldHubRequest,
  verifyWorldHubRequest,
} from "./server.js";
import {
  serializeDevelopmentWorldError,
  encodeDevelopmentWorldValue as encode,
} from "#internal/workflow/development-world-codec.js";

describe("World hub transport", () => {
  it("dispatches over HTTP, batches in order, flushes on close and rejects unknown ops", async () => {
    const writeMulti = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const queue = vi.fn(async () => ({ messageId: "msg-test" }));
    const onDeployment = vi.fn();
    const remoteDeploymentId = vi.fn(async () => "remote");
    const server = createServer(
      createWorldHubServer({
        secret: "secret",
        onDeployment,
        world: {
          specVersion: 8,
          getDeploymentId: remoteDeploymentId,
          queue,
          streams: { writeMulti, close },
          runs: { get: async () => ({ createdAt: new Date(0) }) },
        } as unknown as World,
      }),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const client = await createWorldHubWorld({
      url,
      secret: "secret",
      deploymentId: "deployment",
      deploymentUrl: "https://deployment.test",
      streamFlushIntervalMs: 1000,
    });
    try {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      expect(await client.getDeploymentId()).toBe("deployment");
      expect(await client.getDeploymentId()).toBe("deployment");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(remoteDeploymentId).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
      for (const chunk of ["a", "b", "c"]) await client.streams.write("run", "stream", chunk);
      await client.streams.close("run", "stream");
      expect(writeMulti).toHaveBeenCalledTimes(2);
      expect(writeMulti).toHaveBeenNthCalledWith(1, "run", "stream", ["a"], {
        operationId: expect.any(String),
      });
      expect(writeMulti).toHaveBeenNthCalledWith(2, "run", "stream", ["b", "c"], {
        operationId: expect.any(String),
      });
      expect(close).toHaveBeenCalledExactlyOnceWith("run", "stream", {
        operationId: expect.any(String),
      });
      expect(await client.runs.get("run")).toEqual({ createdAt: new Date(0) });
      expect(onDeployment).toHaveBeenCalled();
      await client.queue("__wkf_step_test" as never, {} as never);
      expect(queue).toHaveBeenLastCalledWith("__wkf_step_test", {}, { deploymentId: "deployment" });
      await client.queue("__wkf_step_test" as never, {} as never, { deploymentId: "other" });
      expect(queue).toHaveBeenLastCalledWith("__wkf_step_test", {}, { deploymentId: "other" });
      const body = encode({ operation: "__proto__.oops", arguments: [] });
      const response = await fetch(`${url}/world/v1/rpc`, {
        method: "POST",
        body,
        headers: signWorldHubRequest("secret", "POST", "/world/v1/rpc", body),
      });
      expect(response.status).toBe(400);
    } finally {
      await client.close?.();
      server.close();
      await once(server, "close");
    }
  });
  it("signs dispatches and retries failures with stable message ids", async () => {
    const ids: string[] = [];
    let calls = 0;
    const fakeFetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const body = String(init?.body);
      expect(verifyWorldHubRequest("secret", "POST", url.pathname, body, headers)).toBe(true);
      expect(headers.get("x-vercel-protection-bypass")).toBe("bypass");
      ids.push(headers.get("x-vqs-message-id")!);
      return ++calls === 1 ? new Response("failed", { status: 500 }) : Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const queue = createWorldHubDispatcher({
      secret: "secret",
      bypassSecret: "bypass",
      resolveDeploymentUrl: () => "https://deployment.test",
      fetch: fakeFetch,
    });
    await queue("workflow-test" as never, {} as never, { deploymentId: "deployment" });
    await vi.waitFor(() => expect(ids).toHaveLength(2), { timeout: 2000 });
    expect(ids[0]).toBe(ids[1]);
  });
});

afterEach(() => vi.unstubAllEnvs());
it("registers env deployment fallbacks and exposes opt-in counters", async () => {
  vi.stubEnv("VERCEL_URL", undefined);
  vi.stubEnv("VERCEL_DEPLOYMENT_ID", undefined);
  vi.stubEnv("WORLD_HUB_DEPLOYMENT_ID", "local-bot");
  vi.stubEnv("WORLD_HUB_DEPLOYMENT_URL", "http://bot.test");
  vi.stubEnv("WORLD_HUB_STATS", "1");
  vi.stubEnv("WORLD_HUB_SECRET", "secret");
  const onDeployment = vi.fn();
  const writeMulti = vi.fn(async () => {});
  const server = createServer(
    createWorldHubServer({
      secret: "secret",
      onDeployment,
      world: { specVersion: 8, streams: { writeMulti, close: async () => {} } } as unknown as World,
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  vi.stubEnv("WORLD_HUB_URL", `http://127.0.0.1:${(server.address() as { port: number }).port}`);
  const before = getWorldHubStats();
  const world = await createWorld();
  try {
    await world.streams.write("run", "text", "a");
    await world.streams.write("run", "text", "b");
    await world.streams.close("run", "text");
    expect(onDeployment).toHaveBeenCalledWith("local-bot", "http://bot.test");
    const after = getWorldHubStats();
    expect(after.rpcCalls - before.rpcCalls).toBe(4);
    expect(after.streamChunks - before.streamChunks).toBe(2);
    expect(after.writeMultiCalls - before.writeMultiCalls).toBe(2);
    expect(after.operations["streams.writeMulti"]).toBe(
      (before.operations["streams.writeMulti"] ?? 0) + 2,
    );
    after.operations["streams.writeMulti"] = -1;
    expect(getWorldHubStats().operations["streams.writeMulti"]).not.toBe(-1);
  } finally {
    await world.close?.();
    server.close();
    await once(server, "close");
  }
});

it.each(["x-world-hub-deployment-id", "x-world-hub-deployment-url"])(
  "rejects tampered %s before registration on RPC and streams",
  async (name) => {
    const onDeployment = vi.fn();
    const server = createServer(
      createWorldHubServer({ secret: "secret", onDeployment, world: { specVersion: 8 } as World }),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      for (const method of ["POST", "GET"]) {
        const path = method === "POST" ? "/world/v1/rpc" : "/world/v1/streams?runId=run&name=text";
        const body = method === "POST" ? encode({ operation: "world.info", arguments: [] }) : "";
        const headers = new Headers(
          signWorldHubRequest(
            "secret",
            method,
            path,
            body,
            undefined,
            new Headers({
              "x-world-hub-deployment-id": "deployment",
              "x-world-hub-deployment-url": "https://deployment.test",
            }),
          ),
        );
        headers.set(name, "https://attacker.test");
        const response = await fetch(url + path, {
          method,
          headers,
          body: method === "POST" ? body : undefined,
        });
        expect(response.status).toBe(401);
      }
      expect(onDeployment).not.toHaveBeenCalled();
      const client = await createWorldHubWorld({
        url,
        secret: "secret",
        deploymentId: "deployment",
        deploymentUrl: "https://deployment.test",
      });
      expect(onDeployment).toHaveBeenCalledExactlyOnceWith("deployment", "https://deployment.test");
      await client.close?.();
    } finally {
      server.close();
      await once(server, "close");
    }
  },
);
it("rejects tampered dispatch metadata before calling the queue handler", async () => {
  const server = createServer(
    createWorldHubServer({ secret: "secret", world: { specVersion: 8 } as World }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = await createWorldHubWorld({
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    secret: "secret",
  });
  const handler = vi.fn(async () => ({ ok: true }));
  const delivery = client.createQueueHandler("workflow-", handler);
  const fakeFetch = vi.fn(async (input, init) => {
    for (const name of [
      "x-world-hub-deployment-id",
      "x-world-hub-deployment-url",
      "x-vqs-queue-name",
      "x-vqs-message-id",
      "x-vqs-message-attempt",
    ]) {
      const headers = new Headers(init?.headers);
      headers.set(name, "tampered");
      expect((await delivery(new Request(String(input), { ...init, headers }))).status).toBe(401);
    }
    expect(handler).not.toHaveBeenCalled();
    const response = await delivery(new Request(String(input), init));
    expect(response.status).toBe(200);
    return response;
  }) as typeof fetch;
  try {
    const queue = createWorldHubDispatcher({
      secret: "secret",
      resolveDeploymentUrl: () => "https://deployment.test",
      fetch: fakeFetch,
    });
    await queue("workflow-test" as never, {} as never, { deploymentId: "deployment" });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
  } finally {
    await client.close?.();
    server.close();
    await once(server, "close");
  }
});

async function withHubWorld(world: unknown, test: (client: World) => Promise<void>) {
  const server = createServer(createWorldHubServer({ secret: "secret", world: world as World }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = await createWorldHubWorld({
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    secret: "secret",
    // Tests must complete before a timer-based first flush could ever fire.
    streamFlushIntervalMs: 60_000,
  });
  try {
    await test(client);
  } finally {
    await client.close?.().catch(() => {});
    server.close();
    await once(server, "close");
  }
}

it("flushes idle streams immediately, coalesces only in flight, and orders close", async () => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const writes: [string, unknown[]][] = [];
  const close = vi.fn(async () => {});
  const writeMulti = vi.fn(async (_run, name: string, chunks: unknown[]) => {
    writes.push([name, chunks]);
    if (name === "text" && writes.filter(([n]) => n === "text").length === 1) await first.promise;
    else if (name === "text") await second.promise;
  });
  await withHubWorld({ specVersion: 8, streams: { writeMulti, close } }, async (client) => {
    try {
      await client.streams.write("run", "text", "a");
      await vi.waitFor(() => expect(writes).toEqual([["text", ["a"]]]));
      await client.streams.write("run", "text", "b");
      await client.streams.write("run", "text", "c");
      await client.streams.write("run", "other", "independent");
      await vi.waitFor(() => expect(writes).toHaveLength(2));
      expect(writes[1]).toEqual(["other", ["independent"]]);
      const closing = client.streams.close("run", "text");
      expect(close).not.toHaveBeenCalled();
      first.resolve();
      await vi.waitFor(() => expect(writes).toHaveLength(3));
      expect(writes[2]).toEqual(["text", ["b", "c"]]);
      expect(close).not.toHaveBeenCalled();
      second.resolve();
      await closing;
      expect(close).toHaveBeenCalledOnce();
    } finally {
      first.resolve();
      second.resolve();
    }
  });
});

it("latches stream errors and propagates them through writes and read/close barriers", async () => {
  const writeMulti = vi.fn(async () => {
    throw new Error("write failed");
  });
  const close = vi.fn(async () => {});
  await withHubWorld({ specVersion: 8, streams: { writeMulti, close } }, async (client) => {
    await client.streams.write("run", "text", "a");
    await expect(client.streams.close("run", "text")).rejects.toThrow("write failed");
    await expect(client.streams.write("run", "text", "b")).rejects.toThrow("write failed");
    await expect(client.streams.writeMulti!("run", "text", ["c"])).rejects.toThrow("write failed");
    await expect(client.streams.getChunks("run", "text")).rejects.toThrow("write failed");
    expect(writeMulti).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });
});

it("retains ordered individual writes when writeMulti is unavailable", async () => {
  const write = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  await withHubWorld({ specVersion: 8, streams: { write, close } }, async (client) => {
    await client.streams.write("run", "text", "a");
    await client.streams.writeMulti!("run", "text", ["b", "c"]);
    await client.streams.close("run", "text");
    expect(write.mock.calls.map((args) => args.slice(0, 3))).toEqual([
      ["run", "text", "a"],
      ["run", "text", "b"],
      ["run", "text", "c"],
    ]);
  });
});

it("forwards the SDK event batch unchanged and leaves legacy hook creates single", async () => {
  const createBatch = vi.fn(async () => ({ results: [] }));
  const create = vi.fn(async () => ({ event: { eventType: "hook_created" } }));
  await withHubWorld({ specVersion: 8, events: { create, createBatch } }, async (client) => {
    await client.events.createBatch!("run", [], { requestId: "request" });
    expect(createBatch).toHaveBeenCalledExactlyOnceWith("run", [], { requestId: "request" });
    const event = {
      eventType: "hook_created",
      correlationId: "hook",
      eventData: { token: "token" },
    } as const;
    await Promise.all([client.events.create("run", event), client.events.create("run", event)]);
    expect(create).toHaveBeenCalledTimes(2);
  });
});

it("batches advertised hook claims while preserving each result, guard, and conflict error", async () => {
  const conflict = Object.assign(new Error("Hook token is owned"), {
    name: "HookConflictError",
    token: "taken",
    runId: "owner",
    status: 409,
  });
  const create = vi.fn(async () => {});
  const createHookBatch = vi.fn(
    async (_run, entries: { event: { eventData: { token: string } } }[]) => ({
      results: entries.map(({ event }, index: number) =>
        index === 1
          ? { error: serializeDevelopmentWorldError(conflict) }
          : {
              value: {
                event: { ...event, eventId: `event-${index}` },
                hook: { token: event.eventData.token },
              },
            },
      ),
    }),
  );
  await withHubWorld({ specVersion: 8, events: { create, createHookBatch } }, async (client) => {
    const events = ["inbox", "taken", "steering"].map((token, index) => ({
      eventType: "hook_created" as const,
      correlationId: `hook-${index}`,
      eventData: { token, metadata: new Uint8Array([index]) },
    }));
    const params = { requestId: "request", eventCount: 1, sinceCursor: "cursor" };
    const results = await Promise.allSettled(
      events.map((event) => client.events.create("run", event, params)),
    );
    expect(createHookBatch).toHaveBeenCalledExactlyOnceWith(
      "run",
      events.map((event) => ({ event, params })),
    );
    expect(create).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ status: "fulfilled", value: { hook: { token: "inbox" } } });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: {
        name: "HookConflictError",
        message: "Hook token is owned",
        token: "taken",
        runId: "owner",
        status: 409,
      },
    });
    expect(results[2]).toMatchObject({
      status: "fulfilled",
      value: { hook: { token: "steering" } },
    });
  });
});

it("rejects every hook claim on a failed batch without retrying", async () => {
  const createHookBatch = vi.fn(async () => {
    throw new Error("transaction failed");
  });
  await withHubWorld(
    { specVersion: 8, events: { create: async () => {}, createHookBatch } },
    async (client) => {
      const event = {
        eventType: "hook_created",
        correlationId: "hook",
        eventData: { token: "token" },
      } as const;
      const results = await Promise.allSettled([
        client.events.create("run", event),
        client.events.create("run", event),
      ]);
      expect(results).toMatchObject([
        { status: "rejected", reason: { message: "transaction failed" } },
        { status: "rejected", reason: { message: "transaction failed" } },
      ]);
      expect(createHookBatch).toHaveBeenCalledOnce();
    },
  );
});

it("preserves durable hook conflicts, force-claim victims and inline event deltas", async () => {
  const value = {
    event: { eventType: "hook_conflict", eventData: { token: "taken", conflictingRunId: "owner" } },
    hook: { claimedFrom: { runId: "victim", hookId: "victim-hook" } },
    events: [{ eventId: "event-1", createdAt: new Date(0) }],
    cursor: "event-1",
    hasMore: false,
  };
  const createHookBatch = vi.fn(async () => ({ results: [{ value }] }));
  await withHubWorld(
    { specVersion: 8, events: { create: async () => {}, createHookBatch } },
    async (client) => {
      expect(
        await client.events.create("run", {
          eventType: "hook_created",
          correlationId: "hook",
          eventData: { token: "taken", force: true },
        }),
      ).toEqual(value);
    },
  );
});

it("rejects a malformed hook batch response for every claim", async () => {
  const createHookBatch = vi.fn(async () => ({ results: [{ value: {} }] }));
  await withHubWorld(
    { specVersion: 8, events: { create: async () => {}, createHookBatch } },
    async (client) => {
      const event = {
        eventType: "hook_created",
        correlationId: "hook",
        eventData: { token: "token" },
      } as const;
      const results = await Promise.allSettled([
        client.events.create("run", event),
        client.events.create("run", event),
      ]);
      expect(results).toMatchObject([
        { status: "rejected", reason: { message: "Invalid world hook batch response" } },
        { status: "rejected", reason: { message: "Invalid world hook batch response" } },
      ]);
      expect(createHookBatch).toHaveBeenCalledOnce();
    },
  );
});
