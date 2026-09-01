import { describe, expect, it } from "vitest";

import { parseConnectPrincipalType } from "./register-integration-commands.js";

describe("parseConnectPrincipalType", () => {
  it.each(["app", "user"] as const)("accepts %s", (principalType) => {
    expect(parseConnectPrincipalType(principalType)).toBe(principalType);
  });

  it("rejects unsupported principal types", () => {
    expect(() => parseConnectPrincipalType("jwt-bearer")).toThrow(
      'Expected principal type "app" or "user".',
    );
  });
});
