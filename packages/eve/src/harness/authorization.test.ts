import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import {
  clearPendingAuthorization,
  consumeAuthorizationResult,
  getPendingAuthorization,
  PendingAuthorizationResultKey,
  setPendingAuthorization,
} from "#harness/authorization.js";
import type { ConnectionPrincipal } from "#runtime/connections/types.js";

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
