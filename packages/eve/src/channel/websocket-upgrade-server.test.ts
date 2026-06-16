import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { describe, expect, it } from "vitest";

import { createWebSocketUpgradeServer } from "#public/channels/index.js";

interface UpgradeFixture {
  readonly head: Buffer;
  readonly nodeRequest: IncomingMessage;
  readonly request: Request;
  readonly socket: Duplex;
}

function createUpgradeFixture(input: { nodeUrl?: string | undefined; url?: string } = {}) {
  const nodeRequest = {
    headers: { host: "eve.test" },
    url: input.nodeUrl,
  } as IncomingMessage;
  const socketLike = {
    destroyed: false,
    destroy() {
      socketLike.destroyed = true;
      return this;
    },
  };
  const socket = socketLike as Duplex;
  const head = Buffer.from("head");
  const request = new Request(input.url ?? "https://eve.test/voice?token=abc");

  Object.defineProperty(request, "runtime", {
    value: {
      node: {
        req: nodeRequest,
        upgrade: {
          head,
          socket,
        },
      },
    },
  });

  return {
    head,
    nodeRequest,
    request,
    socket,
  } satisfies UpgradeFixture;
}

async function createHooks() {
  const bridge = createWebSocketUpgradeServer();
  const hooks = await bridge.route(new Request("https://eve.test/voice"), {} as never);

  return {
    bridge,
    hooks,
  };
}

describe("createWebSocketUpgradeServer", () => {
  it("creates an unlistened Node server for SDK upgrade listeners", () => {
    const bridge = createWebSocketUpgradeServer();
    const server: Server = bridge.server;

    expect(typeof server.on).toBe("function");
    expect(typeof bridge.route).toBe("function");
  });

  it("forwards matched raw Node upgrades into registered server listeners", async () => {
    const { bridge, hooks } = await createHooks();
    const fixture = createUpgradeFixture({ nodeUrl: "/voice?token=abc" });
    const seen: string[] = [];

    bridge.server.on("upgrade", async (request, socket, head) => {
      await Promise.resolve();
      seen.push(`${request.url}:${head.toString("utf8")}:${socket === fixture.socket}`);
    });

    await expect(hooks.upgrade?.(fixture.request)).resolves.toEqual({ handled: true });
    expect(seen).toEqual(["/voice?token=abc:head:true"]);
  });

  it("fills a missing Node request URL from the Web upgrade request", async () => {
    const { bridge, hooks } = await createHooks();
    const fixture = createUpgradeFixture({
      nodeUrl: undefined,
      url: "https://eve.test/voice?token=from-web-request",
    });

    bridge.server.on("upgrade", (request) => {
      expect(request.url).toBe("/voice?token=from-web-request");
    });

    await expect(hooks.upgrade?.(fixture.request)).resolves.toEqual({ handled: true });
  });

  it("returns a clear response when the current host has no Node upgrade tuple", async () => {
    const { hooks } = await createHooks();

    const result = await hooks.upgrade?.(new Request("https://eve.test/voice"));

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(501);
    await expect((result as Response).json()).resolves.toEqual({
      error: "This WebSocket route cannot expose a Node upgrade event on the current host.",
      ok: false,
    });
  });

  it("returns a clear response when no upgrade listener has been attached", async () => {
    const { hooks } = await createHooks();
    const fixture = createUpgradeFixture();

    const result = await hooks.upgrade?.(fixture.request);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(500);
    await expect((result as Response).json()).resolves.toEqual({
      error: "No upgrade listeners are registered on this WebSocket server bridge.",
      ok: false,
    });
  });
});
