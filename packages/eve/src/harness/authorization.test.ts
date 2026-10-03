import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import {
  CallbackBaseUrlKey,
  consumeAuthorizationResult,
  getHookUrl,
  PendingAuthorizationResultKey,
} from "#harness/authorization.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("authorization callback URLs", () => {
  it("includes the Vercel automation bypass query when configured", () => {
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "secret value");
    const ctx = new ContextContainer();
    ctx.set(CallbackBaseUrlKey, "https://agent.example.com");
    ctx.set(SessionIdKey, "session-1");

    expect(contextStorage.run(ctx, () => getHookUrl("linear", "attempt-1"))).toBe(
      "https://agent.example.com/eve/v1/connections/linear/callback/attempt-1/eve%3Ainbox%3Av1%3Aeve%3Asession%3Asession-1%3Ainbox?x-vercel-protection-bypass=secret+value",
    );
  });
});

describe("authorization callback results", () => {
  it("consumes each callback result once", () => {
    const ctx = new ContextContainer();
    ctx.set(PendingAuthorizationResultKey, [
      {
        attemptId: "attempt-notion",
        callback: { method: "GET", params: { code: "notion-code" } },
        hookUrl: "https://agent.example.com/notion",
        name: "notion",
        principal: { type: "app" },
      },
      {
        attemptId: "attempt-linear",
        callback: { method: "GET", params: { code: "linear-code" } },
        hookUrl: "https://agent.example.com/linear",
        name: "linear",
        principal: { type: "app" },
      },
    ]);

    contextStorage.run(ctx, () => {
      expect(consumeAuthorizationResult("notion")).toMatchObject({
        callback: { params: { code: "notion-code" } },
      });
      expect(ctx.get(PendingAuthorizationResultKey)).toMatchObject([{ name: "linear" }]);
      expect(consumeAuthorizationResult("notion")).toBeUndefined();
      expect(consumeAuthorizationResult("linear")).toMatchObject({
        callback: { params: { code: "linear-code" } },
      });
      expect(ctx.has(PendingAuthorizationResultKey)).toBe(false);
      expect(consumeAuthorizationResult("linear")).toBeUndefined();
    });
  });

  it("does not confuse same-named tool and connection callbacks", () => {
    const ctx = new ContextContainer();
    ctx.set(PendingAuthorizationResultKey, [
      {
        callback: { method: "GET", params: { code: "tool-code" } },
        hookUrl: "https://agent.example.com/tool",
        name: "linear",
        principal: { type: "app" },
      },
      {
        callback: { method: "GET", params: { code: "connection-code" } },
        hookUrl: "https://agent.example.com/connection",
        instanceId: "connection:linear-account",
        name: "linear",
        principal: { type: "app" },
      },
    ]);

    contextStorage.run(ctx, () => {
      expect(() => consumeAuthorizationResult("linear", "connection:other-account")).toThrow(
        "resolved connection changed while sign-in was pending",
      );
      expect(consumeAuthorizationResult("linear")).toMatchObject({
        callback: { params: { code: "tool-code" } },
      });
      expect(consumeAuthorizationResult("linear", "connection:linear-account")).toMatchObject({
        callback: { params: { code: "connection-code" } },
      });
    });
  });
});
