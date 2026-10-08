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
import { encodeDevelopmentWorldValue as encode } from "#internal/workflow/development-world-codec.js";

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
      expect(writeMulti).not.toHaveBeenCalled();
      await client.streams.close("run", "stream");
      expect(writeMulti).toHaveBeenCalledExactlyOnceWith("run", "stream", ["a", "b", "c"]);
      expect(close).toHaveBeenCalledOnce();
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
    expect(after.rpcCalls - before.rpcCalls).toBe(3);
    expect(after.streamChunks - before.streamChunks).toBe(2);
    expect(after.writeMultiCalls - before.writeMultiCalls).toBe(1);
    expect(after.operations["streams.writeMulti"]).toBe(
      (before.operations["streams.writeMulti"] ?? 0) + 1,
    );
    after.operations["streams.writeMulti"] = -1;
    expect(getWorldHubStats().operations["streams.writeMulti"]).not.toBe(-1);
  } finally {
    await world.close?.();
    server.close();
    await once(server, "close");
  }
});
