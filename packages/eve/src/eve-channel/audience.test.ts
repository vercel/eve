import { describe, expect, it } from "vitest";

import { defaultEveAudience } from "#eve-channel/audience.js";
import type { AudienceInput } from "#shared/conversation-context.js";

function input(
  principalType: string | null,
  environment: AudienceInput<undefined>["environment"] = "production",
): Omit<AudienceInput<undefined>, "state"> {
  return {
    auth:
      principalType === null
        ? null
        : {
            attributes: {},
            authenticator: "test",
            principalType,
          },
    channel: { kind: "http" },
    environment,
    mode: "conversation",
  };
}

describe("defaultEveAudience", () => {
  it.each([
    [null, "public"],
    ["anonymous", "public"],
    ["user", "private"],
    ["service", "private"],
    ["runtime", "private"],
    ["app", "unknown"],
  ] as const)("classifies %s as %s", (principalType, audience) => {
    expect(defaultEveAudience(input(principalType))).toBe(audience);
  });

  it.each([null, "anonymous", "user", "service", "runtime", "local-dev", "app"] as const)(
    "classifies %s as public during development",
    (principalType) => {
      expect(defaultEveAudience(input(principalType, "development"))).toBe("public");
    },
  );
});
