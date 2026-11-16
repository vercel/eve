import { describe, expect, it } from "vitest";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { accessScopeForUser } from "@shared/identity/access-scope";

describe("principal scope", () => {
  it("accepts the workspace derived from the authenticated user", () => {
    const scope = accessScopeForUser("better-auth:user-1");
    expect(
      scopeFromPrincipal({
        attributes: { workspaceId: scope.workspaceId },
        authenticator: "authjs",
        principalId: scope.userId,
        principalType: "user",
      })
    ).toEqual(scope);
  });

  it("rejects a workspace attribute that belongs to another user", () => {
    const victim = accessScopeForUser("better-auth:victim");
    expect(() =>
      scopeFromPrincipal({
        attributes: { workspaceId: victim.workspaceId },
        authenticator: "authjs",
        principalId: "better-auth:attacker",
        principalType: "user",
      })
    ).toThrow("does not belong to the authenticated user");
  });
});
