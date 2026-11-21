import { afterEach, describe, expect, it, vi } from "vitest";

import { createPublicDispatcher, UnguardedRuntimeError } from "#execution/public-destination.js";

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
