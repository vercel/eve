import { createServer } from "node:http";

import { Agent, Dispatcher1Wrapper } from "undici";
import { describe, expect, it } from "vitest";

describe("undici dispatcher compatibility", () => {
  it("bridges an undici 8 agent to Node fetch", async () => {
    const server = createServer((_request, response) => {
      response.end("wrapped response");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected an ephemeral TCP listener.");
    }

    const dispatcher = new Dispatcher1Wrapper(new Agent());

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}`, {
        dispatcher,
      } as RequestInit & { dispatcher: Dispatcher1Wrapper });

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("wrapped response");
    } finally {
      await dispatcher.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });
});
