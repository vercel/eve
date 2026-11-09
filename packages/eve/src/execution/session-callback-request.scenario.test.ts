import type { LookupAddress } from "node:dns";
import { createServer, type Server } from "node:http";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { postSessionCallbackRequest } from "#execution/session-callback-request.js";

const dnsMocks = vi.hoisted(() => ({ addresses: [] as LookupAddress[] }));

vi.mock("node:dns", () => ({
  lookup: (
    _hostname: string,
    _options: unknown,
    callback: (error: Error | null, addresses: LookupAddress[]) => void,
  ) => callback(null, dnsMocks.addresses),
}));

describe("postSessionCallbackRequest destination guard", () => {
  const received: string[] = [];
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (body += chunk));
      request.on("end", () => {
        received.push(body);
        response.writeHead(202).end("accepted");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected an ephemeral TCP listener.");
    }
    port = address.port;
  });

  afterEach(() => {
    received.length = 0;
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });

  it.each([
    ["a private address", "1", [{ address: "10.0.0.5", family: 4 }]],
    ["link-local cloud metadata", "1", [{ address: "169.254.169.254", family: 4 }]],
    [
      "a public and a private address",
      "1",
      [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ],
    ],
    ["loopback outside local development", "", [{ address: "127.0.0.1", family: 4 }]],
  ])("refuses to connect when a callback hostname resolves to %s", async (_name, eveDev, addrs) => {
    vi.stubEnv("EVE_DEV", eveDev);
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    dnsMocks.addresses = addrs;

    const delivery = postSessionCallbackRequest({
      body: { kind: "session.completed" },
      logFailures: false,
      url: `http://callback.example.test:${String(port)}/eve/v1/callback/token`,
    });

    await expect(delivery).rejects.toMatchObject({
      message: expect.stringContaining("must not target localhost, private"),
      name: "FatalError",
    });
    expect(received).toEqual([]);
  });

  it("delivers to a hostname resolving to loopback on a local development server", async () => {
    vi.stubEnv("EVE_DEV", "1");
    dnsMocks.addresses = [{ address: "127.0.0.1", family: 4 }];

    const delivered = await postSessionCallbackRequest({
      body: { kind: "session.completed" },
      url: `http://callback.example.test:${String(port)}/eve/v1/callback/token`,
    });

    expect(delivered.status).toBe(202);
    await expect(delivered.text()).resolves.toBe("accepted");
    expect(received).toEqual([JSON.stringify({ kind: "session.completed" })]);
  });
});
