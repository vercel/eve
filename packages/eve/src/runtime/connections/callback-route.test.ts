import { beforeEach, describe, expect, it, vi } from "vitest";

import { createEveConnectionCallbackRoutePath } from "#protocol/routes.js";
import type { RouteContext } from "#public/definitions/channel.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import {
  handleConnectionCallbackRequest,
  handleLegacyConnectionCallbackRequest,
} from "#execution/connections/callback-route.js";

const getHookByTokenMock = vi.fn();
const resumeHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  getHookByToken: (...args: unknown[]) => getHookByTokenMock(...args),
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
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
    getHookByTokenMock.mockReset();
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

  it("rejects requests with a missing authorization attempt ID with 400", async () => {
    const response = await handleConnectionCallbackRequest(
      new Request("https://app.example.com/eve/v1/connections/linear/callback/tok"),
      buildRouteContext({ name: "linear", token: "tok" }),
    );
    expect(response.status).toBe(400);
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("encodes a GET callback for a stamped current authorization hook", async () => {
    const hook = installCurrentHook("tok123");
    resumeHookMock.mockResolvedValueOnce(undefined);
    const url = `https://app.example.com${createEveConnectionCallbackRoutePath("linear", "attempt-1", "tok123")}?code=abc&state=xyz`;
    const response = await handleConnectionCallbackRequest(
      new Request(url, {
        headers: { "x-probe": "1" },
        method: "GET",
      }),
      buildRouteContext({ attemptId: "attempt-1", name: "linear", token: "tok123" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Authorization complete");
    expect(body).toContain("You can close this tab and return to your app.");
    expect(body).toContain('aria-labelledby="authorization-title"');
    expect(body).toContain('class="icon" aria-hidden="true"');

    expect(resumeHookMock).toHaveBeenCalledTimes(1);
    const [target, payload] = resumeHookMock.mock.calls[0] ?? [];
    expect(target).toBe(hook);
    // Exact match: only parsed params + method cross into the hook
    // payload. The inbound `x-probe` header (and any `Cookie`) is dropped.
    expect(payload).toEqual({
      kind: "deliver",
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
      payloads: [
        {
          authorizationCallback: {
            attemptId: "attempt-1",
            connectionName: "linear",
            callback: {
              params: { code: "abc", state: "xyz" },
              method: "GET",
            },
          },
        },
      ],
      version: 1,
    });
  });

  it("keeps pre-attempt callback URLs resumable for pinned workflows", async () => {
    const hook = installCurrentHook("tok123");
    resumeHookMock.mockResolvedValueOnce(undefined);
    const response = await handleLegacyConnectionCallbackRequest(
      new Request("https://app.example.com/eve/v1/connections/linear/callback/tok123?code=abc"),
      buildRouteContext({ name: "linear", token: "tok123" }),
    );

    expect(response.status).toBe(200);
    const authorizationCallback = {
      callback: { method: "GET", params: { code: "abc" } },
      connectionName: "linear",
      legacy: true,
    };
    expect(resumeHookMock).toHaveBeenCalledWith(hook, {
      kind: "deliver",
      payload: { authorizationCallback },
      payloads: [{ authorizationCallback }],
      version: 1,
    });
  });

  it("uses the markerless stable-inbox cohort's legacy send encoding", async () => {
    const runId = "legacy-session";
    const hook = { metadata: undefined, runId, token: "tok123" };
    const stableHook = {
      metadata: undefined,
      runId,
      token: sessionCommandHookToken(runId),
    };
    getHookByTokenMock.mockResolvedValueOnce(hook).mockResolvedValueOnce(stableHook);
    resumeHookMock.mockResolvedValueOnce(undefined);

    const response = await handleConnectionCallbackRequest(
      new Request(
        `https://app.example.com${createEveConnectionCallbackRoutePath("linear", "attempt-1", "tok123")}?code=abc`,
      ),
      buildRouteContext({ attemptId: "attempt-1", name: "linear", token: "tok123" }),
    );

    expect(response.status).toBe(200);
    expect(getHookByTokenMock).toHaveBeenNthCalledWith(1, "tok123");
    expect(getHookByTokenMock).toHaveBeenNthCalledWith(2, sessionCommandHookToken(runId));
    expect(resumeHookMock).toHaveBeenCalledWith(hook, {
      auth: undefined,
      caller: undefined,
      delivery: undefined,
      kind: "send",
      payload: {
        authorizationCallback: {
          attemptId: "attempt-1",
          callback: { method: "GET", params: { code: "abc" } },
          connectionName: "linear",
        },
      },
      requestId: undefined,
      taskDeliveryId: undefined,
      turnPolicy: undefined,
    });
  });

  it("captures form-encoded POST bodies before resuming the hook", async () => {
    installCurrentHook("tok123");
    resumeHookMock.mockResolvedValueOnce(undefined);
    const url = `https://app.example.com${createEveConnectionCallbackRoutePath("linear", "attempt-1", "tok123")}`;
    await handleConnectionCallbackRequest(
      new Request(url, {
        body: "code=abc&state=xyz",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      buildRouteContext({ attemptId: "attempt-1", name: "linear", token: "tok123" }),
    );

    const [, payload] = resumeHookMock.mock.calls[0] ?? [];
    expect(payload).toEqual({
      kind: "deliver",
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
      payloads: [
        {
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
      ],
      version: 1,
    });
  });

  it("returns 404 when the workflow runtime reports no hook for the supplied token", async () => {
    // Target lookup fails when no workflow run is currently waiting on
    // the supplied token, e.g. the workflow already completed,
    // disposed the hook, or the user replayed a stale callback URL.
    getHookByTokenMock.mockRejectedValueOnce(new Error("hook not found"));
    const response = await handleConnectionCallbackRequest(
      new Request(
        `https://app.example.com${createEveConnectionCallbackRoutePath("linear", "attempt-1", "tok")}`,
      ),
      buildRouteContext({ attemptId: "attempt-1", name: "linear", token: "tok" }),
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual(expect.objectContaining({ ok: false }));
  });
});

function installCurrentHook(token: string) {
  const hook = {
    metadata: { sessionInboxWireVersion: 1 },
    runId: "current-session",
    token,
  };
  getHookByTokenMock.mockResolvedValueOnce(hook);
  return hook;
}
