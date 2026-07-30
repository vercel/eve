import { describe, expect, it } from "vitest";
import { eveChildEnvironment } from "./environment.js";

describe("eve child environment", () => {
  it("removes Buzz signing credentials without mutating the parent environment", () => {
    const parent = {
      BUZZ_PRIVATE_KEY: "private",
      BUZZ_AUTH_TAG: "auth",
      BUZZ_API_TOKEN: "token",
      BUZZ_RELAY_URL: "wss://relay.example.com",
      PATH: "/bin",
    };

    expect(eveChildEnvironment(parent)).toEqual({
      BUZZ_RELAY_URL: "wss://relay.example.com",
      PATH: "/bin",
    });
    expect(parent.BUZZ_PRIVATE_KEY).toBe("private");
  });
});
