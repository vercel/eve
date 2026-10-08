import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { World } from "#compiled/@workflow/world/index.js";
import { createWorldHubWorld } from "./index.js";
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
    const onDeployment = vi.fn();
    const server = createServer(
      createWorldHubServer({
        secret: "secret",
        onDeployment,
        world: {
          specVersion: 8,
          getDeploymentId: async () => "deployment",
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
      deploymentUrl: "https://deployment.test",
      streamFlushIntervalMs: 1000,
    });
    try {
      for (const chunk of ["a", "b", "c"]) await client.streams.write("run", "stream", chunk);
      expect(writeMulti).not.toHaveBeenCalled();
      await client.streams.close("run", "stream");
      expect(writeMulti).toHaveBeenCalledExactlyOnceWith("run", "stream", ["a", "b", "c"]);
      expect(close).toHaveBeenCalledOnce();
      expect(await client.runs.get("run")).toEqual({ createdAt: new Date(0) });
      expect(onDeployment).toHaveBeenCalled();
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
