import { createServer, type Server } from "node:http";

import { describe, expect, it } from "vitest";

import { Client } from "./client.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP address.");
  return `http://127.0.0.1:${address.port}`;
}

describe("Client redirect policy", () => {
  it("does not follow a credential-bearing redirect to another origin", async () => {
    let redirectedRequests = 0;
    const destination = createServer((_request, response) => {
      redirectedRequests += 1;
      response.end();
    });
    const destinationUrl = await listen(destination);
    const source = createServer((_request, response) => {
      response.writeHead(307, { location: `${destinationUrl}/capture` });
      response.end();
    });
    const sourceUrl = await listen(source);

    try {
      const client = new Client({
        host: sourceUrl,
        auth: { bearer: "secret" },
        redirect: "manual",
      });
      await expect(client.health()).rejects.toMatchObject({ status: 307 });
      expect(redirectedRequests).toBe(0);
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => source.close(() => resolve())),
        new Promise<void>((resolve) => destination.close(() => resolve())),
      ]);
    }
  });
});
