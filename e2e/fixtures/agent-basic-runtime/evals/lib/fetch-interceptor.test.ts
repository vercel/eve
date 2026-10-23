import { afterEach, expect, it, vi } from "vitest";
import { interceptFetchOrigin } from "@eve-e2e/config/frontend";

afterEach(() => vi.unstubAllGlobals());

it.each(["first", "second"] as const)(
  "keeps overlapping origin routes independent when the %s registration ends first",
  async (firstToUnregister) => {
    const baseFetch = vi.fn(async () => new Response("base"));
    vi.stubGlobal("fetch", baseFetch);
    const first = vi.fn(async () => new Response("alice"));
    const second = vi.fn(async () => new Response("bob"));
    const unregisterFirst = interceptFetchOrigin("https://alice.invalid", first);
    const unregisterSecond = interceptFetchOrigin("https://bob.invalid", second);

    try {
      expect(await (await fetch("https://alice.invalid/stream")).text()).toBe("alice");
      expect(await (await fetch(new Request("https://bob.invalid/stream"))).text()).toBe("bob");
      (firstToUnregister === "first" ? unregisterFirst : unregisterSecond)();
      expect(await (await fetch("https://other.invalid/stream")).text()).toBe("base");
      expect(
        await (
          await fetch(`https://${firstToUnregister === "first" ? "bob" : "alice"}.invalid/stream`)
        ).text(),
      ).toBe(firstToUnregister === "first" ? "bob" : "alice");
      expect(baseFetch).toHaveBeenCalledTimes(1);
    } finally {
      unregisterFirst();
      unregisterSecond();
    }
    expect(globalThis.fetch).toBe(baseFetch);
    expect(first).toHaveBeenCalledTimes(firstToUnregister === "first" ? 1 : 2);
    expect(second).toHaveBeenCalledTimes(firstToUnregister === "second" ? 1 : 2);
  },
);

it("shares registrations across independently loaded helper copies", async () => {
  const baseFetch = vi.fn(async () => new Response("base"));
  vi.stubGlobal("fetch", baseFetch);
  vi.resetModules();
  const firstCopy = await import("@eve-e2e/config/frontend");
  const unregisterFirst = firstCopy.interceptFetchOrigin(
    "https://alice.invalid",
    async () => new Response("alice"),
  );
  vi.resetModules();
  const secondCopy = await import("@eve-e2e/config/frontend");
  const unregisterSecond = secondCopy.interceptFetchOrigin(
    "https://bob.invalid",
    async () => new Response("bob"),
  );
  try {
    expect(await (await fetch("https://alice.invalid/stream")).text()).toBe("alice");
    expect(await (await fetch("https://bob.invalid/stream")).text()).toBe("bob");
    unregisterFirst();
    expect(await (await fetch("https://bob.invalid/stream")).text()).toBe("bob");
  } finally {
    unregisterFirst();
    unregisterSecond();
  }
  expect(globalThis.fetch).toBe(baseFetch);
  expect(baseFetch).not.toHaveBeenCalled();
});

it("passes the raw base fetch to handlers without routing through another registration", async () => {
  const baseFetch = vi.fn(async () => new Response("base"));
  vi.stubGlobal("fetch", baseFetch);
  const unregisterFirst = interceptFetchOrigin(
    "https://alice.invalid",
    async () => new Response("alice"),
  );
  const unregisterSecond = interceptFetchOrigin("https://bob.invalid", (input, init, rawBase) =>
    rawBase(input, init),
  );
  try {
    expect(await (await fetch("https://bob.invalid/stream")).text()).toBe("base");
    expect(baseFetch).toHaveBeenCalledTimes(1);
  } finally {
    unregisterFirst();
    unregisterSecond();
  }
});

it("keeps the captured base fetch available to in-flight handlers after unregister", async () => {
  const baseFetch = vi.fn(async () => new Response("base"));
  vi.stubGlobal("fetch", baseFetch);
  let resume!: () => void;
  const pause = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const unregister = interceptFetchOrigin("https://alice.invalid", async (input, init, rawBase) => {
    await pause;
    return rawBase(input, init);
  });
  const inFlight = fetch("https://alice.invalid/stream");
  unregister();
  resume();
  expect(await (await inFlight).text()).toBe("base");
  expect(globalThis.fetch).toBe(baseFetch);
});

it("rejects a duplicate origin rather than silently replacing its handler", () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("base")),
  );
  const unregister = interceptFetchOrigin(
    "https://alice.invalid",
    async () => new Response("alice"),
  );
  try {
    expect(() =>
      interceptFetchOrigin("https://alice.invalid", async () => new Response("bob")),
    ).toThrow("Fetch origin already intercepted");
  } finally {
    unregister();
  }
});

it("does not replace a later unrelated fetch override on cleanup", () => {
  const baseFetch = vi.fn(async () => new Response("base"));
  vi.stubGlobal("fetch", baseFetch);
  const unregister = interceptFetchOrigin(
    "https://alice.invalid",
    async () => new Response("alice"),
  );
  const laterFetch = vi.fn(async () => new Response("later"));
  globalThis.fetch = laterFetch;
  unregister();
  unregister();
  expect(globalThis.fetch).toBe(laterFetch);
});

it("composes a new registration with a later fetch wrapper after cleanup", async () => {
  const baseFetch = vi.fn(async () => new Response("base"));
  vi.stubGlobal("fetch", baseFetch);
  const unregisterFirst = interceptFetchOrigin(
    "https://alice.invalid",
    async () => new Response("alice"),
  );
  const previousDispatch = globalThis.fetch;
  const laterFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    previousDispatch(input, init),
  );
  globalThis.fetch = laterFetch;
  unregisterFirst();
  expect(globalThis.fetch).toBe(laterFetch);

  const unregisterSecond = interceptFetchOrigin("https://bob.invalid", (input, init, rawBase) =>
    rawBase(input, init),
  );
  try {
    expect(await (await fetch("https://bob.invalid/stream")).text()).toBe("base");
    expect(laterFetch).toHaveBeenCalledTimes(1);
    expect(baseFetch).toHaveBeenCalledTimes(1);
  } finally {
    unregisterSecond();
  }
  expect(globalThis.fetch).toBe(laterFetch);
});
