import { afterEach, describe, expect, it, vi } from "vitest";

import { Client } from "#client/client.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Client request policy", () => {
  it("enforces its redirect policy for info, health, raw fetch, and sessions", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ agent: {} }))
      .mockResolvedValueOnce(Response.json({ ok: true, status: "ready", workflowId: "wf" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json({ continuationToken: "eve:test", sessionId: "session_1" }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        new Response(`${JSON.stringify({ data: {}, type: "session.completed" })}\n`),
      );
    const client = new Client({ host: "https://eve.test", redirect: "manual" });

    await client.info();
    await client.health();
    await client.fetch("/custom", { redirect: "follow" });
    await (await client.session().send("hello")).result();

    expect(fetchMock.mock.calls).toHaveLength(5);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.redirect).toBe("manual");
    }
  });
});
