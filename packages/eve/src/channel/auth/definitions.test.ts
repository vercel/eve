import { describe, expect, it } from "vitest";

import {
  declaredAuthChallenges,
  httpBasic,
  jwtHmac,
  none,
  oauthResource,
  withAuthChallenges,
} from "#channel/auth/definitions.js";

describe("auth policy metadata", () => {
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
    expect(declaredAuthChallenges(none())).toEqual([]);
    expect(
      declaredAuthChallenges(
        oauthResource(() => null, { issuer: "https://issuer.example.com" }),
      ).map((c) => c.scheme),
    ).toEqual(["Bearer"]);
  });
});
