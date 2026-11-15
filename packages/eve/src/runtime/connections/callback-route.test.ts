import { beforeEach, describe, expect, it, vi } from "vitest";

import { createEveConnectionCallbackRoutePath } from "#protocol/routes.js";
import type { RouteContext } from "#public/definitions/channel.js";
import { handleConnectionCallbackRequest } from "#execution/connections/callback-route.js";
import { registerHost } from "#execution/hosts.js";

const resumeHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  getHookByToken: async (token: string) => ({ runId: "owner", specVersion: 6, token }),
  // Vercel-shaped: owners run on their own deployment, so ingress resumes by token.
  getWorld: async () => ({ capabilities: { deploymentAffinity: true } }),
  resumeHook: (token: string, payload: unknown) => resumeHookMock(token, payload),
}));

/** A session's stable inbox, which its sign-in callback URLs name. */
const INBOX = "eve:inbox:v1:eve:session:wrun_1:inbox";

function buildRouteContext(params: Readonly<Record<string, string>>): RouteContext {
  return {
    waitUntil: () => {},
    params,
    requestIp: null,
  };
}

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

  it("rejects requests with a missing authorization attempt ID with 400", async () => {
    const response = await handleConnectionCallbackRequest(
      new Request("https://app.example.com/eve/v1/connections/linear/callback/tok"),
      buildRouteContext({ name: "linear", token: "tok" }),
    );
    expect(response.status).toBe(400);
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("forwards a GET callback into resumeHook as parsed params with no request headers", async () => {
    resumeHookMock.mockResolvedValueOnce(undefined);
    const url = `https://app.example.com${createEveConnectionCallbackRoutePath("linear", "attempt-1", INBOX)}?code=abc&state=xyz`;
    const response = await handleConnectionCallbackRequest(
      new Request(url, {
        headers: { "x-probe": "1" },
        method: "GET",
      }),
      buildRouteContext({ attemptId: "attempt-1", name: "linear", token: INBOX }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Authorization complete");
    expect(body).toContain("You can close this tab and return to your app.");
    expect(body).toContain('aria-labelledby="authorization-title"');
    expect(body).toContain('class="icon" aria-hidden="true"');

    expect(resumeHookMock).toHaveBeenCalledTimes(1);
    const [token, payload] = resumeHookMock.mock.calls[0] ?? [];
    expect(token).toBe(INBOX);
    // Exact match: only parsed params + method cross into the hook
    // payload. The inbound `x-probe` header (and any `Cookie`) is dropped.
    expect(payload).toEqual({
      kind: "authorization-callback",
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
    });
  });

  it("captures form-encoded POST bodies before resuming the hook", async () => {
    resumeHookMock.mockResolvedValueOnce(undefined);
    const url = `https://app.example.com${createEveConnectionCallbackRoutePath("linear", "attempt-1", INBOX)}`;
    await handleConnectionCallbackRequest(
      new Request(url, {
        body: "code=abc&state=xyz",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      buildRouteContext({ attemptId: "attempt-1", name: "linear", token: INBOX }),
    );

    const [, payload] = resumeHookMock.mock.calls[0] ?? [];
    expect(payload).toEqual({
      kind: "authorization-callback",
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
    });
  });

  it("does not report success when the provider redirects back with an OAuth error", async () => {
    resumeHookMock.mockResolvedValueOnce(undefined);
    const url = `https://app.example.com${createEveConnectionCallbackRoutePath("linear", "attempt-1", INBOX)}?error=access_denied&state=xyz`;
    const response = await handleConnectionCallbackRequest(
      new Request(url),
      buildRouteContext({ attemptId: "attempt-1", name: "linear", token: INBOX }),
    );

    // The callback still resumes the workflow so it can fail the attempt.
    expect(resumeHookMock).toHaveBeenCalledTimes(1);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).not.toContain("Authorization complete");
    expect(body).toContain("Authorization not completed");
  });

  it("returns 404 when the workflow runtime reports no hook for the supplied token", async () => {
    // `resumeHook` throws when no workflow run is currently waiting on
    // the supplied token, e.g. the workflow already completed,
    // disposed the hook, or the user replayed a stale callback URL.
    resumeHookMock.mockRejectedValueOnce(new Error("hook not found"));
    const response = await handleConnectionCallbackRequest(
      new Request(
        `https://app.example.com${createEveConnectionCallbackRoutePath("linear", "attempt-1", INBOX)}`,
      ),
      buildRouteContext({ attemptId: "attempt-1", name: "linear", token: INBOX }),
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual(expect.objectContaining({ ok: false }));
  });

  it("delivers to a session a host runs in this process, without asking Workflow", async () => {
    const delivered: unknown[] = [];
    const release = registerHost({
      deliver: async (token, sent) => {
        if (token !== INBOX) return undefined;
        delivered.push(sent);
        return "delivered";
      },
      runEnded: () => undefined,
      cancelRun: () => undefined,
    });
    try {
      const response = await handleConnectionCallbackRequest(
        new Request(
          `https://app.example.com${createEveConnectionCallbackRoutePath("linear", "attempt-1", INBOX)}?code=abc`,
        ),
        buildRouteContext({ attemptId: "attempt-1", name: "linear", token: INBOX }),
      );
      expect(response.status).toBe(200);
    } finally {
      release();
    }
    expect(delivered).toEqual([
      {
        kind: "authorization-callback",
        payloads: [
          {
            authorizationCallback: {
              attemptId: "attempt-1",
              callback: { method: "GET", params: { code: "abc" } },
              connectionName: "linear",
            },
          },
        ],
      },
    ]);
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("answers not pending for a hosted session that ended, without asking Workflow", async () => {
    const release = registerHost({
      deliver: async (token) => (token === INBOX ? "gone" : undefined),
      runEnded: () => undefined,
      cancelRun: () => undefined,
    });
    try {
      const response = await handleConnectionCallbackRequest(
        new Request(
          `https://app.example.com${createEveConnectionCallbackRoutePath("linear", "attempt-1", INBOX)}?code=abc`,
        ),
        buildRouteContext({ attemptId: "attempt-1", name: "linear", token: INBOX }),
      );
      expect(response.status).toBe(404);
    } finally {
      release();
    }
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("delivers a callback to a workflow tool run's own sign-in hook", async () => {
    resumeHookMock.mockResolvedValueOnce(undefined);
    const token = "eve:sign-in:v1:0b1c2d3e";
    const response = await handleConnectionCallbackRequest(
      new Request(
        `https://app.example.com${createEveConnectionCallbackRoutePath("linear", "attempt-1", token)}?code=abc`,
      ),
      buildRouteContext({ attemptId: "attempt-1", name: "linear", token }),
    );
    expect(response.status).toBe(200);
    expect(resumeHookMock).toHaveBeenCalledExactlyOnceWith(
      token,
      expect.objectContaining({ kind: "authorization-callback" }),
    );
  });

  it.each([
    // Alice's order workflow waits on a hook it named for the order.
    ["a hook authored code named", "order:1042"],
    // A channel's address for a session is an inbox too, but no sign-in URL names it.
    ["a session inbox other than its stable one", "eve:inbox:v1:slack:C1:1700000000.000100"],
  ])(
    "answers not pending for %s, without reading the request or resuming the hook",
    async (_, token) => {
      const request = new Request(
        `https://app.example.com${createEveConnectionCallbackRoutePath("linear", "attempt-1", token)}`,
        { body: "code=abc", method: "POST" },
      );
      const response = await handleConnectionCallbackRequest(
        request,
        buildRouteContext({ attemptId: "attempt-1", name: "linear", token }),
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: "Connection callback not pending.",
        ok: false,
      });
      expect(request.bodyUsed).toBe(false);
      expect(resumeHookMock).not.toHaveBeenCalled();
    },
  );
});
