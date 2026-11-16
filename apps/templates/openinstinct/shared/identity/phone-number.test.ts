import { describe, expect, it } from "vitest";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { normalizeAuthPhoneNumber } from "@shared/identity/phone-number";

describe("multi-user request identity", () => {
  it("derives stable personal workspaces without exposing provider ids", () => {
    const first = accessScopeForUser("better-auth:123");
    const second = accessScopeForUser("better-auth:456");

    expect(first).toEqual(accessScopeForUser("better-auth:123"));
    expect(first.workspaceId).not.toBe(second.workspaceId);
    expect(first.workspaceId).not.toContain("better-auth:123");
  });

  it("defaults phone numbers to the +1 country code", () => {
    expect(normalizeAuthPhoneNumber("(202) 555-0123")).toBe("+12025550123");
    expect(normalizeAuthPhoneNumber("1 202 555 0123")).toBe("+12025550123");
    expect(normalizeAuthPhoneNumber("+44 7911 123456")).toBe("+447911123456");
    expect(normalizeAuthPhoneNumber("not-a-number")).toBeUndefined();
  });
});
