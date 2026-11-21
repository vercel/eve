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

  it.each([
    ["/eve/alice/v1/session?x=1", "http://127.0.0.1:5001/eve/v1/session?x=1"],
    ["/eve/bob/v1", "http://127.0.0.1:5002/eve/v1"],
  ])("routes workspace request %s to its agent server", async (path, target) => {
    vi.stubEnv("EVE_SVELTEKIT_PRODUCTION_ORIGIN", "https://ignored.example.com");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("agent"));
    const resolve = vi.fn(async () => new Response("app"));

    await createEveHandle({
      origin: "https://also-ignored.example.com",
      agents: { alice: "http://127.0.0.1:5001", bob: "http://127.0.0.1:5002" },
    })({ event: createEvent(`https://app.example.com${path}`), resolve });

    expect(forwardedUrl(fetchMock)).toBe(target);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(["/eve/v1/health", "/eve/unknown/v1/health", "/eve/alice/v1-docs"])(
    "leaves unmounted workspace route %s to SvelteKit",
    async (path) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("agent"));
      const response = await createEveHandle({ agents: { alice: "http://127.0.0.1:5001" } })({
        event: createEvent(`https://app.example.com${path}`),
        resolve: async () => new Response("app"),
      });

      expect(await response.text()).toBe("app");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(["option", "env"])("keeps named routes on a shared %s origin", async (source) => {
    vi.stubEnv("EVE_SVELTEKIT_PRODUCTION_ORIGIN", "https://agents.example.com/root");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("agent"));

    await createEveHandle(source === "option" ? { origin: "https://agents.example.com" } : {})({
      event: createEvent("https://app.example.com/eve/alice/v1/session?x=1"),
      resolve: async () => new Response("app"),
    });

    expect(forwardedUrl(fetchMock)).toBe("https://agents.example.com/eve/alice/v1/session?x=1");
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
