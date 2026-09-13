import { describe, expect, it } from "vitest";

import { defaultEveAudience } from "#eve-channel/audience.js";
import type { AudienceInput } from "#shared/conversation-context.js";

function input(principalType: string | null): Omit<AudienceInput<undefined>, "state"> {
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
    environment: "production",
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
});
