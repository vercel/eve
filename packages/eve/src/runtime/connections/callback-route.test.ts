import { beforeEach, describe, expect, it, vi } from "vitest";

import { createEveConnectionCallbackRoutePath } from "#protocol/routes.js";
import type { RouteContext } from "#public/definitions/channel.js";
import { handleConnectionCallbackRequest } from "#execution/connections/callback-route.js";

const dispatchMock = vi.fn();

vi.mock("#execution/session/ingress.js", () => ({
  dispatchSessionCommand: (...args: unknown[]) => dispatchMock(...args),
}));

function buildRouteContext(params: Readonly<Record<string, string>>): RouteContext {
  return {
    waitUntil: () => {},
    params,
    requestIp: null,
  };
}

describe("handleConnectionCallbackRequest", () => {
  beforeEach(() => {
    dispatchMock.mockReset();
  });

  it("rejects requests with a missing connection name with 400", async () => {
    const response = await handleConnectionCallbackRequest(
      new Request("https://app.example.com/eve/v1/connections//callback/tok"),
      buildRouteContext({ sessionId: "tok" }),
    );
    expect(response.status).toBe(400);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("rejects requests with a missing token with 400", async () => {
    const response = await handleConnectionCallbackRequest(
      new Request("https://app.example.com/eve/v1/connections/linear/callback/"),
      buildRouteContext({ name: "linear" }),
    );
    expect(response.status).toBe(400);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("rejects requests with a missing authorization attempt ID with 400", async () => {
    const response = await handleConnectionCallbackRequest(
      new Request("https://app.example.com/eve/v1/connections/linear/callback/tok"),
      buildRouteContext({ name: "linear", sessionId: "tok" }),
    );
    expect(response.status).toBe(400);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("forwards a GET callback into session admission as parsed params with no request headers", async () => {
    dispatchMock.mockResolvedValueOnce(undefined);
    const url = `https://app.example.com${createEveConnectionCallbackRoutePath("linear", "attempt-1", "tok123")}?code=abc&state=xyz`;
    const response = await handleConnectionCallbackRequest(
      new Request(url, {
        headers: { "x-probe": "1" },
        method: "GET",
      }),
      buildRouteContext({ attemptId: "attempt-1", name: "linear", sessionId: "tok123" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Authorization complete");
    expect(body).toContain("You can close this tab and return to your app.");
    expect(body).toContain('aria-labelledby="authorization-title"');
    expect(body).toContain('class="icon" aria-hidden="true"');

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const [token, payload] = dispatchMock.mock.calls[0] ?? [];
    expect(token).toBe("tok123");
    // Exact match: only parsed params + method cross into the hook
    // payload. The inbound `x-probe` header (and any `Cookie`) is dropped.
    expect(payload).toEqual({
      kind: "send",
      payload: {
        authorizationCallback: {
          attemptId: "attempt-1",
          connectionName: "linear",
          callback: {
            params: { code: "abc", state: "xyz" },
            method: "GET",
          },
        },
      },
    });
  });

  it("captures form-encoded POST bodies before admitting the callback", async () => {
    dispatchMock.mockResolvedValueOnce(undefined);
    const url = `https://app.example.com${createEveConnectionCallbackRoutePath("linear", "attempt-1", "tok123")}`;
    await handleConnectionCallbackRequest(
      new Request(url, {
        body: "code=abc&state=xyz",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      buildRouteContext({ attemptId: "attempt-1", name: "linear", sessionId: "tok123" }),
    );

    const [, payload] = dispatchMock.mock.calls[0] ?? [];
    expect(payload).toEqual({
      kind: "send",
      payload: {
        authorizationCallback: {
          attemptId: "attempt-1",
          connectionName: "linear",
          callback: {
            params: { code: "abc", state: "xyz" },
            method: "POST",
            body: "code=abc&state=xyz",
          },
        },
      },
    });
  });

  it("acknowledges the callback and reports delivery failure through background work", async () => {
    dispatchMock.mockRejectedValueOnce(new Error("hook not found"));
    const outcomes: Promise<unknown>[] = [];
    const ctx: RouteContext = {
      ...buildRouteContext({ attemptId: "attempt-1", name: "linear", sessionId: "tok" }),
      waitUntil: (task) => {
        outcomes.push(task.catch((error) => error));
      },
    };
    const response = await handleConnectionCallbackRequest(
      new Request(
        `https://app.example.com${createEveConnectionCallbackRoutePath("linear", "attempt-1", "tok")}`,
      ),
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await outcomes[0]).toEqual(new Error("hook not found"));
  });
});
