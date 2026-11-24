import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPublicDispatcher,
  fetchPublicDestination,
  UnguardedRuntimeError,
} from "#execution/public-destination.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("undici");
  vi.resetModules();
});

describe("createPublicDispatcher", () => {
  it("refuses when fetch ignores the dispatcher, after sending only the probe", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      requested.push(String(input));
      return new Response("reached");
    });

    await expect(createPublicDispatcher({ allowLoopback: false })).rejects.toBeInstanceOf(
      UnguardedRuntimeError,
    );
    expect(requested).toEqual(["http://dispatcher-probe.invalid/"]);
  });

  it("refuses when undici cannot load", async () => {
    vi.doMock("undici", () => {
      throw new Error("undici is unavailable");
    });
    const destination = await import("#execution/public-destination.js");

    await expect(
      destination.createPublicDispatcher({ allowLoopback: false }),
    ).rejects.toBeInstanceOf(destination.UnguardedRuntimeError);
  });
});

describe("fetchPublicDestination on a runtime that cannot guard outbound requests", () => {
  function unguardedRuntime(): string[] {
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      requested.push(String(input));
      return new Response("reached");
    });
    return requested;
  }

  it("refuses when the platform gives no fetchUntrusted", async () => {
    const requested = unguardedRuntime();

    await expect(
      fetchPublicDestination("https://docs.example/alice", {}, { allowLoopback: false }, {}),
    ).rejects.toBeInstanceOf(UnguardedRuntimeError);
    expect(requested).toEqual(["http://dispatcher-probe.invalid/"]);
  });

  it("sends the request through the platform's fetchUntrusted", async () => {
    const requested = unguardedRuntime();
    const received: Request[] = [];
    const fetchUntrusted = async (request: Request) => {
      received.push(request);
      return new Response("from the platform");
    };

    const fetched = await fetchPublicDestination(
      "https://docs.example/bob",
      { method: "POST", body: "note", redirect: "error" },
      { allowLoopback: false },
      { fetchUntrusted },
    );

    expect(await fetched.response.text()).toBe("from the platform");
    expect(received.map((request) => [request.url, request.method, request.redirect])).toEqual([
      ["https://docs.example/bob", "POST", "error"],
    ]);
    expect(await received[0]!.text()).toBe("note");
    expect(requested).toEqual(["http://dispatcher-probe.invalid/"]);
    await fetched.close();
  });
});
