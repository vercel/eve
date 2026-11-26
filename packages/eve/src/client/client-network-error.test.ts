import { afterEach, describe, expect, it, vi } from "vitest";

import { Client } from "#client/client.js";
import { ClientNetworkError } from "#client/client-network-error.js";
import {
  EVE_MESSAGE_STREAM_VERSION,
  EVE_STREAM_TAIL_INDEX_HEADER,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/session-http.js";
import { encodeTestLine, testTurnFacts } from "#internal/testing/events.js";
import { EveError } from "#shared/eve-error.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const client = () => new Client({ baseUrl: "https://eve.test" });
const attached = () => client().sessions.attach("session_1");

async function firstStreamEvent() {
  const events = attached().stream({
    follow: false,
    reconnect: { maxAttempts: 2, baseDelayMs: 0 },
  });
  return await events[Symbol.asyncIterator]().next();
}

describe("ClientNetworkError", () => {
  it.each([
    { name: "a send", request: () => attached().send("Hello.") },
    { name: "a session create", request: () => client().sessions.create({ message: "Hello." }) },
    { name: "a stream open after its retries", request: () => firstStreamEvent() },
    { name: "Client.fetch", request: () => client().fetch("/custom") },
  ])("wraps a rejected fetch for $name", async ({ request }) => {
    const rejection = new TypeError("fetch failed");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(rejection);

    const error = await request().catch((caught: unknown) => caught);

    expect(ClientNetworkError.is(error)).toBe(true);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({
      name: "ClientNetworkError",
      code: "network_error",
      message: "fetch failed",
      cause: rejection,
    });
    expect(EveError.is(error)).toBe(false);
  });

  it("passes through a redirect the policy refused", async () => {
    const refused = new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(refused);

    await expect(client().fetch("/custom")).rejects.toBe(refused);
  });

  it("throws an invalid request's TypeError without sending it", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");

    const error = await client()
      .fetch("/custom", { method: "GET", body: "unexpected" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TypeError);
    expect(ClientNetworkError.is(error)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves an abort as the signal's AbortError", async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      controller.abort();
      throw controller.signal.reason;
    });

    const error = await attached()
      .send("Hello.", { signal: controller.signal })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({ name: "AbortError" });
  });

  it("still retries a stream open after a disconnect", async () => {
    const facts = testTurnFacts(0, "Sunny.", ["d_0"]);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response(facts.map(encodeTestLine).join(""), {
          headers: {
            [EVE_STREAM_TAIL_INDEX_HEADER]: String(facts.length - 1),
            [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION,
          },
        }),
      );

    await expect(firstStreamEvent()).resolves.toMatchObject({ done: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("recognizes an error created by another copy of eve", () => {
    const error = new ClientNetworkError(new TypeError("Load failed"));
    const foreign = Object.defineProperty(
      new TypeError(error.message),
      Symbol.for("eve.error.lineage"),
      { value: Reflect.get(error, Symbol.for("eve.error.lineage")) },
    );

    expect(ClientNetworkError.is(foreign)).toBe(true);
    expect(ClientNetworkError.is(new TypeError("Load failed"))).toBe(false);
  });
});
