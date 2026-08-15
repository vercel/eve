import { describe, expect, it, vi } from "vitest";

import {
  callTeamsConnectorApi,
  replyToTeamsActivity,
  resolveTeamsAccessToken,
  sendTeamsActivity,
  splitTeamsMessageText,
  normalizeTeamsContinuationAddress,
  teamsContinuationToken,
  triggerTeamsTypingIndicator,
  updateTeamsActivity,
} from "#public/channels/teams/api.js";

describe("Teams Connector API wrapper", () => {
  it("builds URL-encoded continuation tokens", () => {
    expect(
      teamsContinuationToken({
        conversationId: "19:abc@thread.skype",
        replyToActivityId: "A:1",
        tenantId: "T 1",
      }),
    ).toBe("T%201:19%3Aabc%40thread.skype:A%3A1");
  });

  it("normalizes channel thread suffixes before building continuation tokens", () => {
    expect(
      normalizeTeamsContinuationAddress({
        conversationId: "19:abc@thread.tacv2;messageid=THREAD_ROOT",
        replyToActivityId: "VOLATILE_ACTIVITY",
      }),
    ).toEqual({
      conversationId: "19:abc@thread.tacv2",
      replyToActivityId: "THREAD_ROOT",
    });
    expect(
      teamsContinuationToken({
        conversationId: "19:abc@thread.tacv2;messageid=THREAD_ROOT",
        tenantId: "TENANT",
      }),
    ).toBe("TENANT:19%3Aabc%40thread.tacv2:THREAD_ROOT");
  });

  it("requests and caches Bot Connector access tokens", async () => {
    const apiFetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ access_token: "token-1", expires_in: 3600 }),
    );

    const options = {
      credentials: { appId: "APP", appPassword: "secret" },
      fetch: apiFetch,
      loginBaseUrl: "https://login.example.test",
    };
    await expect(resolveTeamsAccessToken(options)).resolves.toBe("token-1");
    await expect(resolveTeamsAccessToken(options)).resolves.toBe("token-1");

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [url, init] = apiFetch.mock.calls[0]!;
    expect(String(url)).toBe("https://login.example.test/botframework.com/oauth2/v2.0/token");
    expect(String((init as RequestInit).body)).toContain("client_id=APP");
  });

  it("calls Connector endpoints with bearer auth", async () => {
    const requests: Array<{ body: unknown; method: string; url: string }> = [];
    const apiFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        body: init?.body ? JSON.parse(String(init.body)) : null,
        method: init?.method ?? "GET",
        url: String(url),
      });
      return Response.json({ id: "ACTIVITY_1" });
    });

    const common = {
      credentials: { tokenProvider: () => "connector-token" },
      conversationId: "CONV",
      fetch: apiFetch,
      serviceUrl: "https://smba.example.test/teams",
    };

    await sendTeamsActivity({
      ...common,
      body: { text: "hello", type: "message" },
    });
    await replyToTeamsActivity({
      ...common,
      activityId: "ROOT",
      body: { text: "reply", type: "message" },
    });
    await updateTeamsActivity({
      ...common,
      activityId: "ACTIVITY_1",
      body: { text: "updated", type: "message" },
    });
    await triggerTeamsTypingIndicator(common);

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "POST https://smba.example.test/teams/v3/conversations/CONV/activities",
      "POST https://smba.example.test/teams/v3/conversations/CONV/activities/ROOT",
      "PUT https://smba.example.test/teams/v3/conversations/CONV/activities/ACTIVITY_1",
      "POST https://smba.example.test/teams/v3/conversations/CONV/activities",
    ]);
    expect(requests[3]!.body).toEqual({ type: "typing" });
  });

  it("exposes a raw Connector request helper", async () => {
    const apiFetch = vi.fn(async () => Response.json({ ok: true }));
    await callTeamsConnectorApi({
      body: { type: "message", text: "hello" },
      credentials: { tokenProvider: () => "token" },
      fetch: apiFetch,
      path: "/v3/conversations/C/activities",
      serviceUrl: "https://service.example",
    });
    expect(apiFetch).toHaveBeenCalledWith(
      "https://service.example/v3/conversations/C/activities",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("splits long text under the conservative Teams message budget", () => {
    const message = `a${"x".repeat(90 * 1024)}\n\nlast`;
    const chunks = splitTeamsMessageText(message);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 80 * 1024)).toBe(true);
    expect(chunks.join("").replace(/\s+/g, "")).toBe(message.replace(/\s+/g, ""));
  });
});
