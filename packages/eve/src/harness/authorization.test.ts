import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import {
  CallbackBaseUrlKey,
  consumeAuthorizationResult,
  getHookUrl,
  PendingAuthorizationResultKey,
  resolveActiveAuthorizationChallenges,
  getSupersededAuthorizationChallenges,
} from "#harness/authorization.js";
import type { ConnectionPrincipal } from "#shared/connection-types.js";

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
      "https://agent.example.com/eve/v1/connections/linear/callback/attempt-1/session-1%3Aauth?x-vercel-protection-bypass=secret+value",
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

function challenge(
  name: string,
  attemptId: string,
  principal: ConnectionPrincipal = { type: "app" },
) {
  return {
    attemptId,
    challenge: { url: `https://idp.example/${attemptId}` },
    hookUrl: `https://agent.example/${attemptId}`,
    name,
    principal,
  };
}

describe("authorization challenge reduction", () => {
  it("keeps same-name attempts owned by different principals", () => {
    const userA = { id: "user-a", issuer: "idp", type: "user" } as const;
    const userB = { id: "user-b", issuer: "idp", type: "user" } as const;

    expect(
      resolveActiveAuthorizationChallenges([
        challenge("linear", "linear-a", userA),
        challenge("linear", "linear-b", userB),
      ]),
    ).toEqual([challenge("linear", "linear-a", userA), challenge("linear", "linear-b", userB)]);
  });

  it("merges distinct names and replaces only the same name+principal", () => {
    const first = [challenge("linear", "linear-1"), challenge("github", "github-1")];
    const replacement = [challenge("linear", "linear-2")];

    expect(resolveActiveAuthorizationChallenges([...first, ...replacement])).toEqual([
      challenge("github", "github-1"),
      challenge("linear", "linear-2"),
    ]);
    expect(getSupersededAuthorizationChallenges(first, replacement)).toEqual([
      challenge("linear", "linear-1"),
    ]);
  });

  it("keeps only the latest same-scope challenge from one batch", () => {
    const userA = { id: "user-a", issuer: "idp", type: "user" } as const;
    const userB = { id: "user-b", issuer: "idp", type: "user" } as const;
    const first = challenge("linear", "linear-a-1", userA);
    const otherPrincipal = challenge("linear", "linear-b", userB);
    const latest = challenge("linear", "linear-a-2", userA);
    const active = resolveActiveAuthorizationChallenges([first, otherPrincipal, latest]);

    expect(active).toEqual([otherPrincipal, latest]);
  });

  it("reports superseded challenges by exact replacement scope", () => {
    const userA = { id: "user-a", issuer: "idp", type: "user" } as const;
    const userB = { id: "user-b", issuer: "idp", type: "user" } as const;
    const previous = [
      challenge("linear", "linear-a-1", userA),
      challenge("linear", "linear-b-1", userB),
    ];
    const replacements = [challenge("linear", "linear-a-2", userA)];

    expect(getSupersededAuthorizationChallenges(previous, replacements)).toEqual([
      challenge("linear", "linear-a-1", userA),
    ]);
  });
});
