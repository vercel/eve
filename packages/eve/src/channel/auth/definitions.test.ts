import { describe, expect, it } from "vitest";

import {
  admitsAnonymousCallers,
  declaredAuthChallenges,
  httpBasic,
  jwtHmac,
  localDev,
  none,
  oauthResource,
  withAuthChallenges,
} from "#channel/auth/definitions.js";

describe("auth policy metadata", () => {
  it("reads whether a policy admits anonymous callers without calling it", () => {
    const custom = () => {
      throw new Error("A policy read must not authenticate.");
    };
    expect(admitsAnonymousCallers(none())).toBe(true);
    expect(admitsAnonymousCallers([custom, none()])).toBe(true);
    expect(admitsAnonymousCallers([custom, localDev()])).toBe(false);
    expect(admitsAnonymousCallers(custom)).toBe(false);
  });

  it("lists the challenges a policy's 401 advertises, deduped in walk order", () => {
    const basic = httpBasic({ password: "secret-password", username: "alice" });
    const bearer = jwtHmac({
      algorithm: "HS256",
      audiences: ["agent"],
      issuer: "https://issuer.example.com",
      secret: "s".repeat(32),
    });
    expect(declaredAuthChallenges([basic, bearer, bearer]).map((c) => c.scheme)).toEqual([
      "Basic",
      "Bearer",
    ]);
    expect(declaredAuthChallenges(withAuthChallenges(() => null, [{ scheme: "Bearer" }]))).toEqual([
      { scheme: "Bearer" },
    ]);
    expect(declaredAuthChallenges(() => null)).toEqual([]);
    expect(
      declaredAuthChallenges(
        oauthResource(() => null, { issuer: "https://issuer.example.com" }),
      ).map((c) => c.scheme),
    ).toEqual(["Bearer"]);
  });
});
