import { H3, defineWebSocketHandler } from "nitro/h3";
import { expect, it, vi } from "vitest";

import { dispatchChannelWebSocketRequest } from "#internal/nitro/routes/channel-dispatch.js";
import { resolveNitroChannelRuntimeBundle } from "#internal/nitro/routes/runtime-stack.js";

vi.mock("#internal/nitro/routes/runtime-stack.js", () => ({
  resolveNitroChannelRuntimeBundle: vi.fn(),
}));

it("retains the once-resolved channel hooks on the request when middleware replaces the response", async () => {
  const hooks = { upgrade: () => ({ protocol: "eve.test" }), open: vi.fn() };
  const websocket = vi.fn(async () => hooks);
  vi.mocked(resolveNitroChannelRuntimeBundle).mockResolvedValue({
    agentName: "test-agent",
    runtime: {} as never,
    channels: [
      {
        fetch: async () => new Response("unused"),
        logicalPath: "agent/channels/socket.ts",
        method: "WEBSOCKET",
        name: "socket",
        sourceId: "socket",
        sourceKind: "module",
        urlPath: "/socket",
        websocket,
      },
    ],
  });
  const app = new H3();
  app.use(async (_event, next) => {
    const response = await next();
    if (!(response instanceof Response)) throw new Error("Expected an upgrade response.");
    const headers = new Headers(response.headers);
    headers.set("x-middleware-header", "preserved");
    return new Response(response.body, { status: response.status, headers });
  });
  app.get(
    "/socket",
    defineWebSocketHandler((event) =>
      dispatchChannelWebSocketRequest(event, "WEBSOCKET /socket", {} as never),
    ),
  );
  const request = new Request("http://eve.test/socket", { headers: { upgrade: "websocket" } });
  const response = await app.fetch(request);
  expect(response.status, await response.clone().text()).toBe(426);
  expect(response.headers.get("x-middleware-header")).toBe("preserved");
  expect(response).not.toHaveProperty("crossws");
  expect(Reflect.get(request, Symbol.for("crossws.hooks"))).toBe(hooks);
  expect(websocket).toHaveBeenCalledTimes(1);
});
