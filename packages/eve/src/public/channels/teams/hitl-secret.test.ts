import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveTeamsHitlSecret } from "#public/channels/teams/hitl-secret.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveTeamsHitlSecret", () => {
  it("uses the configured HITL secret before the app password", async () => {
    await expect(
      resolveTeamsHitlSecret({ appPassword: "app-password", hitlSecret: "hitl-secret" }),
    ).resolves.toBe("hitl-secret");
  });

  it("falls back to the environment-backed app password", async () => {
    vi.stubEnv("MICROSOFT_APP_PASSWORD", "environment-secret");

    await expect(resolveTeamsHitlSecret({})).resolves.toBe("environment-secret");
  });

  it("rejects empty signing material", async () => {
    await expect(resolveTeamsHitlSecret({ hitlSecret: " " })).rejects.toThrow(/must not be empty/i);
  });
});
