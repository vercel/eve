import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import {
  CallbackBaseUrlKey,
  clearPendingAuthorization,
  consumeAuthorizationResult,
  getPendingAuthorization,
  getHookUrl,
  PendingAuthorizationResultKey,
  setPendingAuthorization,
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
});

function candidateChallenge(name: string, candidateId: string) {
  return {
    candidateId,
    challenge: { url: `https://idp.example/${candidateId}` },
    hookUrl: `https://eve.example/${candidateId}`,
    name,
  };
}

describe("pending authorization state", () => {
  it("merges concurrent candidate challenges by authorization name", () => {
    const first = setPendingAuthorization(undefined, {
      challenges: [candidateChallenge("candidate-1:github", "candidate-1")],
    });
    const second = setPendingAuthorization(first, {
      challenges: [candidateChallenge("candidate-2:github", "candidate-2")],
    });

    expect(getPendingAuthorization(second)?.challenges).toEqual([
      expect.objectContaining({ candidateId: "candidate-1", name: "candidate-1:github" }),
      expect.objectContaining({ candidateId: "candidate-2", name: "candidate-2:github" }),
    ]);
  });

  it("replaces a repeated challenge without duplicating it", () => {
    const first = setPendingAuthorization(undefined, {
      challenges: [candidateChallenge("candidate-1:github", "candidate-1")],
    });
    const second = setPendingAuthorization(first, {
      challenges: [
        {
          ...candidateChallenge("candidate-1:github", "candidate-1"),
          hookUrl: "https://eve.example/refreshed",
        },
      ],
    });

    expect(getPendingAuthorization(second)?.challenges).toEqual([
      expect.objectContaining({ hookUrl: "https://eve.example/refreshed" }),
    ]);
  });
});

describe("pending authorization attempts", () => {
  const challenge = (
    name: string,
    attemptId: string,
    principal: ConnectionPrincipal = { type: "app" },
  ) => ({
    attemptId,
    challenge: { url: `https://idp.example/${attemptId}` },
    hookUrl: `https://agent.example/${attemptId}`,
    name,
    principal,
  });

  it("keeps same-name attempts owned by different principals", () => {
    const userA = { id: "user-a", issuer: "idp", type: "user" } as const;
    const userB = { id: "user-b", issuer: "idp", type: "user" } as const;
    const first = setPendingAuthorization(undefined, {
      challenges: [challenge("linear", "linear-a", userA)],
    });
    const second = setPendingAuthorization(first, {
      challenges: [challenge("linear", "linear-b", userB)],
    });

    expect(getPendingAuthorization(second)?.challenges).toEqual([
      challenge("linear", "linear-a", userA),
      challenge("linear", "linear-b", userB),
    ]);
  });

  it("merges distinct names and replaces only the same name", () => {
    const first = setPendingAuthorization(undefined, {
      challenges: [challenge("linear", "linear-1"), challenge("github", "github-1")],
    });
    const replaced = setPendingAuthorization(first, {
      challenges: [challenge("linear", "linear-2")],
    });

    expect(getPendingAuthorization(replaced)?.challenges).toEqual([
      challenge("github", "github-1"),
      challenge("linear", "linear-2"),
    ]);
  });

  it("clears by exact attempt identity", () => {
    const state = setPendingAuthorization(undefined, {
      challenges: [challenge("linear", "linear-2"), challenge("github", "github-1")],
    });

    expect(clearPendingAuthorization(state, ["linear-1"])).toEqual(state);
    expect(
      getPendingAuthorization(clearPendingAuthorization(state, ["linear-2"]))?.challenges,
    ).toEqual([challenge("github", "github-1")]);
  });
});
