import { afterEach, expect, it, vi } from "vitest";
import channel from "../../agent/channels/eve";

const password = "synthetic-operator-password-at-least-32-bytes";
const authorization = `Basic ${Buffer.from(`operator:${password}`).toString("base64")}`;
const cancel = channel.routes!.find(route => route.method === "POST" && route.path.endsWith("/:sessionId/cancel"))!;
const stream = channel.routes!.find(route => route.method === "GET" && route.path.endsWith("/:sessionId/stream"))!;
afterEach(() => { vi.unstubAllEnvs(); });
it.each(["0", "1"])("rejects cross-origin Basic writes without falling through to dev auth (%s)", async dev => {
  vi.stubEnv("EVE_DEV", dev); vi.stubEnv("BELL_OPERATOR_USERNAME", "operator"); vi.stubEnv("BELL_OPERATOR_PASSWORD", password);
  const callback = vi.fn(async () => ({ status: "accepted", sessionId: "synthetic-session" }));
  const context = { params: { sessionId: "synthetic-session" }, attachSession: () => ({ cancel: callback }) };
  for (const origin of ["https://other.example", "null", ""]) for (const credential of [authorization, "", "Basic d3Jvbmc6d3Jvbmc="]) {
    const response = await cancel.handler(new Request("https://bell.example/eve/v1/session/synthetic-session/cancel", {
      method: "POST", headers: { authorization: credential, origin, "sec-fetch-site": "cross-site", "content-type": "text/plain" }, body: "{}",
    }), context as never);
    if (!(response instanceof Response)) throw new Error("Expected an HTTP response.");
    expect(response.status).toBe(403);
  }
  expect(callback).not.toHaveBeenCalled();
  const response = await cancel.handler(new Request("https://bell.example/eve/v1/session/synthetic-session/cancel", {
    method: "POST", headers: { authorization, origin: "https://bell.example" }, body: "{}",
  }), context as never);
  if (!(response instanceof Response)) throw new Error("Expected an HTTP response.");
  expect(response.status).toBe(202); expect(callback).toHaveBeenCalledOnce();
});

it("accepts the original origin through Next's proxy and rejects a different origin", async () => {
  vi.stubEnv("BELL_OPERATOR_USERNAME", "operator"); vi.stubEnv("BELL_OPERATOR_PASSWORD", password);
  const callback = vi.fn(async () => ({ status: "accepted", sessionId: "synthetic-session" }));
  for (const [origin, status] of [["https://bell.example", 202], ["https://other.example", 403]] as const) {
    const response = await cancel.handler(new Request("http://127.0.0.1:4274/eve/v1/session/synthetic-session/cancel", {
      method: "POST", headers: { authorization, origin, host: "127.0.0.1:4274", "x-forwarded-host": "bell.example", "x-forwarded-proto": "https" }, body: "{}",
    }), { params: { sessionId: "synthetic-session" }, attachSession: () => ({ cancel: callback }) } as never);
    if (!(response instanceof Response)) throw new Error("Expected an HTTP response.");
    expect(response.status).toBe(status);
  }
  expect(callback).toHaveBeenCalledOnce();
});

it("rejects cross-site writes with default local development configuration", async () => {
  vi.stubEnv("EVE_DEV", "1");
  vi.stubEnv("BELL_OPERATOR_USERNAME", "");
  vi.stubEnv("BELL_OPERATOR_PASSWORD", "");
  const callback = vi.fn(async () => ({ status: "accepted", sessionId: "synthetic-session" }));
  const context = { params: { sessionId: "synthetic-session" }, attachSession: () => ({ cancel: callback }) };
  const endpoint = "http://127.0.0.1:4320/eve/v1/session/synthetic-session/cancel";
  const crossSiteHeaders: Record<string, string>[] = [
    { origin: "https://other.example", "sec-fetch-site": "cross-site" },
    { origin: "null", "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "cross-site" },
    { origin: "", "sec-fetch-site": "same-origin" },
  ];
  for (const headers of crossSiteHeaders) {
    const response = await cancel.handler(new Request(endpoint, {
      method: "POST", headers: { ...headers, "content-type": "text/plain" }, body: "{}",
    }), context as never);
    if (!(response instanceof Response)) throw new Error("Expected an HTTP response.");
    expect(response.status).toBe(403);
  }
  expect(callback).not.toHaveBeenCalled();
  const localHeaders: Record<string, string>[] = [{ origin: "http://127.0.0.1:4320" }, {}];
  for (const headers of localHeaders) {
    const response = await cancel.handler(new Request(endpoint, {
      method: "POST", headers, body: "{}",
    }), context as never);
    if (!(response instanceof Response)) throw new Error("Expected an HTTP response.");
    expect(response.status).toBe(202);
  }
  expect(callback).toHaveBeenCalledTimes(2);
});

it("advertises Basic authentication and accepts authenticated server clients", async () => {
  vi.stubEnv("EVE_DEV", "0");
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("BELL_OPERATOR_USERNAME", "operator");
  vi.stubEnv("BELL_OPERATOR_PASSWORD", password);
  const callback = vi.fn(async () => ({ status: "accepted", sessionId: "synthetic-session" }));
  const context = { params: { sessionId: "synthetic-session" }, attachSession: () => ({ cancel: callback }) };
  const endpoint = "https://bell.example/eve/v1/session/synthetic-session/cancel";
  const unauthenticated = await cancel.handler(new Request(endpoint, { method: "POST", body: "{}" }), context as never);
  if (!(unauthenticated instanceof Response)) throw new Error("Expected an HTTP response.");
  expect(unauthenticated.status).toBe(401);
  expect(unauthenticated.headers.get("www-authenticate")).toContain('Basic realm="Bell", charset="UTF-8"');
  expect(unauthenticated.headers.get("www-authenticate")).toContain("Bearer");
  expect(callback).not.toHaveBeenCalled();

  const authenticated = await cancel.handler(new Request(endpoint, {
    method: "POST", headers: { authorization }, body: "{}",
  }), context as never);
  if (!(authenticated instanceof Response)) throw new Error("Expected an HTTP response.");
  expect(authenticated.status).toBe(202);
  expect(callback).toHaveBeenCalledOnce();
});

it("denies development auth for foreign URL, Host, or forwarded Host on reads and writes", async () => {
  vi.stubEnv("EVE_DEV", "1");
  vi.stubEnv("BELL_OPERATOR_USERNAME", "");
  vi.stubEnv("BELL_OPERATOR_PASSWORD", "");
  const attachSession = vi.fn();
  const cases = [
    { origin: "http://foreign.example:4320", host: "foreign.example:4320", forwardedHost: "foreign.example:4320", requestOrigin: "http://foreign.example:4320" },
    { origin: "http://foreign.example:4320", host: "foreign.example:4320", forwardedHost: "foreign.example:4320", requestOrigin: "http://127.0.0.1:4320" },
    { origin: "http://foreign.example:4320", host: "127.0.0.1:4320", forwardedHost: "foreign.example:4320", requestOrigin: "http://127.0.0.1:4320" },
    { origin: "http://127.0.0.1:4320", host: "foreign.example:4320", forwardedHost: "127.0.0.1:4320", requestOrigin: "http://127.0.0.1:4320" },
    { origin: "http://127.0.0.1:4320", host: "127.0.0.1:4320", forwardedHost: "127.0.0.1:4320", requestOrigin: "http://foreign.example:4320" },
  ];
  for (const { origin, host, forwardedHost, requestOrigin } of cases) {
    for (const route of [cancel, stream]) {
      const request = new Request(`${requestOrigin}${route.path.replace(":sessionId", "synthetic-session")}`, {
        method: route.method,
        headers: { origin, host, "x-forwarded-host": forwardedHost, "sec-fetch-site": "same-origin" },
        ...(route.method === "POST" ? { body: "{}" } : {}),
      });
      const response = await route.handler(request, { params: { sessionId: "synthetic-session" }, attachSession } as never);
      if (!(response instanceof Response)) throw new Error("Expected an HTTP response.");
      expect(response.status).toBe(401);
    }
  }
  expect(attachSession).not.toHaveBeenCalled();
});

it.each(["localhost", "127.0.0.1", "[::1]"])("accepts development reads and writes on %s", async host => {
  vi.stubEnv("EVE_DEV", "1");
  vi.stubEnv("BELL_OPERATOR_USERNAME", "");
  vi.stubEnv("BELL_OPERATOR_PASSWORD", "");
  const attachSession = vi.fn(() => ({
    id: "synthetic-session",
    cancel: async () => ({ status: "accepted", sessionId: "synthetic-session" }),
    getStreamTailIndex: async () => -1,
    getEventStream: async () => new ReadableStream({ start(controller) { controller.close(); } }),
  }));
  const origin = `http://${host}:4320`;
  for (const route of [cancel, stream]) {
    const response = await route.handler(new Request(`${origin}${route.path.replace(":sessionId", "synthetic-session")}`, {
      method: route.method,
      headers: { origin, host: `${host}:4320`, "x-forwarded-host": `${host}:4320` },
      ...(route.method === "POST" ? { body: "{}" } : {}),
    }), { params: { sessionId: "synthetic-session" }, attachSession } as never);
    if (!(response instanceof Response)) throw new Error("Expected an HTTP response.");
    expect(response.status).toBe(route.method === "POST" ? 202 : 200);
    await response.text();
  }
  expect(attachSession).toHaveBeenCalledTimes(2);
});
