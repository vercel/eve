import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  EVE_CONNECTION_CALLBACK_ROUTE_PATTERN,
  createEveConnectionCallbackRoutePath,
} from "#protocol/routes.js";
import type { RouteContext } from "#public/definitions/channel.js";
import {
  getConnectionCallbackChannelDefinitions,
  getConnectionCallbackChannelNames,
  handleConnectionCallbackRequest,
  HTTP_CONNECTION_CALLBACK_CHANNEL_NAME_PREFIX,
} from "#runtime/connections/callback-route.js";

const resumeHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  resumeHook: (token: string, payload: unknown) => resumeHookMock(token, payload),
}));

function buildRouteContext(params: Readonly<Record<string, string>>): RouteContext {
  return {
    agent: {} as RouteContext["agent"],
    waitUntil: () => {},
    params,
    requestIp: null,
  };
}

describe("getConnectionCallbackChannelDefinitions", () => {
  it("registers GET and POST entries at the framework callback route pattern", () => {
    const definitions = getConnectionCallbackChannelDefinitions();
    expect(definitions).toHaveLength(2);
    const methods = definitions.map((d) => d.method);
    expect(methods).toEqual(expect.arrayContaining(["GET", "POST"]));
    for (const def of definitions) {
      expect(def.urlPath).toBe(EVE_CONNECTION_CALLBACK_ROUTE_PATTERN);
      expect(def.name.startsWith(HTTP_CONNECTION_CALLBACK_CHANNEL_NAME_PREFIX)).toBe(true);
      expect(def.name).not.toContain(".well-known");
      expect(def.sourceKind).toBe("module");
      expect(def.fetch).toBe(handleConnectionCallbackRequest);
    }
  });

  it("uses unique logical names per (method, urlPath) pair", () => {
    const definitions = getConnectionCallbackChannelDefinitions();
    const names = definitions.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("getConnectionCallbackChannelNames", () => {
  it("returns the same names as getConnectionCallbackChannelDefinitions", () => {
    const definitions = getConnectionCallbackChannelDefinitions();
    const names = getConnectionCallbackChannelNames();
    expect(names.size).toBe(definitions.length);
    for (const def of definitions) {
      expect(names.has(def.name)).toBe(true);
    }
  });
});

describe("handleConnectionCallbackRequest", () => {
  beforeEach(() => {
    resumeHookMock.mockReset();
  });

  it("rejects requests with a missing connection name with 400", async () => {
    const response = await handleConnectionCallbackRequest(
      new Request("https://app.example.com/eve/v1/connections//callback/tok"),
      buildRouteContext({ token: "tok" }),
    );
    expect(response.status).toBe(400);
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("rejects requests with a missing token with 400", async () => {
    const response = await handleConnectionCallbackRequest(
      new Request("https://app.example.com/eve/v1/connections/linear/callback/"),
      buildRouteContext({ name: "linear" }),
    );
    expect(response.status).toBe(400);
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("forwards a GET callback into resumeHook as parsed params with no request headers", async () => {
    resumeHookMock.mockResolvedValueOnce(undefined);
    const url = `https://app.example.com${createEveConnectionCallbackRoutePath("linear", "tok123")}?code=abc&state=xyz`;
    const response = await handleConnectionCallbackRequest(
      new Request(url, {
        headers: { "x-probe": "1" },
        method: "GET",
      }),
      buildRouteContext({ name: "linear", token: "tok123" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Authorization complete");

    expect(resumeHookMock).toHaveBeenCalledTimes(1);
    const [token, payload] = resumeHookMock.mock.calls[0] ?? [];
    expect(token).toBe("tok123");
    // Exact match: only parsed params + method cross into the hook
    // payload. The inbound `x-probe` header (and any `Cookie`) is dropped.
    expect(payload).toEqual({
      kind: "deliver",
      payloads: [
        {
          authorizationCallback: {
            connectionName: "linear",
            callback: {
              params: { code: "abc", state: "xyz" },
              method: "GET",
            },
          },
        },
      ],
    });
  });

  it("captures form-encoded POST bodies before resuming the hook", async () => {
    resumeHookMock.mockResolvedValueOnce(undefined);
    const url = `https://app.example.com${createEveConnectionCallbackRoutePath("linear", "tok123")}`;
    await handleConnectionCallbackRequest(
      new Request(url, {
        body: "code=abc&state=xyz",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      buildRouteContext({ name: "linear", token: "tok123" }),
    );

    const [, payload] = resumeHookMock.mock.calls[0] ?? [];
    expect(payload).toEqual({
      kind: "deliver",
      payloads: [
        {
          authorizationCallback: {
            connectionName: "linear",
            callback: {
              params: { code: "abc", state: "xyz" },
              method: "POST",
              body: "code=abc&state=xyz",
            },
          },
        },
      ],
    });
  });

  it("returns 404 when the workflow runtime reports no hook for the supplied token", async () => {
    // `resumeHook` throws when no workflow run is currently waiting on
    // the supplied token, e.g. the workflow already completed,
    // disposed the hook, or the user replayed a stale callback URL.
    resumeHookMock.mockRejectedValueOnce(new Error("hook not found"));
    const response = await handleConnectionCallbackRequest(
      new Request(
        `https://app.example.com${createEveConnectionCallbackRoutePath("linear", "tok")}`,
      ),
      buildRouteContext({ name: "linear", token: "tok" }),
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual(expect.objectContaining({ ok: false }));
  });
});
