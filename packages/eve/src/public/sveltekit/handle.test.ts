import { afterEach, describe, expect, it, vi } from "vitest";

import { createEveHandle } from "./handle.js";

function forwardedUrl(fetchMock: { mock: { calls: unknown[][] } }): string {
  const forwarded = fetchMock.mock.calls[0]?.[0];
  if (!(forwarded instanceof Request)) throw new Error("expected a forwarded request");
  return forwarded.url;
}

function createEvent(url: string, init?: RequestInit) {
  return { request: new Request(url, init), url: new URL(url) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("createEveHandle", () => {
  it("passes non-eve routes to the SvelteKit handler", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const resolve = vi.fn(async () => new Response("app"));

    const response = await createEveHandle()({
      event: createEvent("https://app.example.com/"),
      resolve,
    });

    expect(await response.text()).toBe("app");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards eve routes to the default loopback origin", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("streamed", { status: 202 }));
    const resolve = vi.fn(async () => new Response("app"));

    const response = await createEveHandle()({
      event: createEvent("https://app.example.com/eve/v1/session?x=1", {
        headers: { authorization: "Bearer token" },
        method: "POST",
      }),
      resolve,
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(response.status).toBe(202);
    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe("http://127.0.0.1:4274/eve/v1/session?x=1");
    expect(forwarded.method).toBe("POST");
    expect(forwarded.headers.get("authorization")).toBe("Bearer token");
    expect(forwarded.headers.get("host")).toBeNull();
  });

  it("forwards to the configured production origin", async () => {
    vi.stubEnv("EVE_SVELTEKIT_PRODUCTION_ORIGIN", "https://agent.example.com/root");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));

    await createEveHandle()({
      event: createEvent("https://app.example.com/eve/v1/health"),
      resolve: async () => new Response("app"),
    });

    expect(forwardedUrl(fetchMock)).toBe("https://agent.example.com/eve/v1/health");
  });

  it("forwards to the configured production port", async () => {
    vi.stubEnv("EVE_SVELTEKIT_PRODUCTION_PORT", "5000");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));

    await createEveHandle()({
      event: createEvent("https://app.example.com/eve/v1/health"),
      resolve: async () => new Response("app"),
    });

    expect(forwardedUrl(fetchMock)).toBe("http://127.0.0.1:5000/eve/v1/health");
  });

  it("prefers an explicit origin option", async () => {
    vi.stubEnv("EVE_SVELTEKIT_PRODUCTION_ORIGIN", "https://ignored.example.com");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));

    await createEveHandle({ origin: "http://127.0.0.1:9000" })({
      event: createEvent("https://app.example.com/eve/v1/health"),
      resolve: async () => new Response("app"),
    });

    expect(forwardedUrl(fetchMock)).toBe("http://127.0.0.1:9000/eve/v1/health");
  });

  it("rejects an out-of-range production port", async () => {
    vi.stubEnv("EVE_SVELTEKIT_PRODUCTION_PORT", "0");

    await expect(
      createEveHandle()({
        event: createEvent("https://app.example.com/eve/v1/health"),
        resolve: async () => new Response("app"),
      }),
    ).rejects.toThrow(/EVE_SVELTEKIT_PRODUCTION_PORT/);
  });

  it("does not forward paths that only share the eve prefix", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const response = await createEveHandle()({
      event: createEvent("https://app.example.com/eve/v1-docs"),
      resolve: async () => new Response("app"),
    });

    expect(await response.text()).toBe("app");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
