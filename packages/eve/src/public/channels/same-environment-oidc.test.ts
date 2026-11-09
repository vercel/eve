import { beforeEach, describe, expect, it, vi } from "vitest";

const { verify } = vi.hoisted(() => ({ verify: vi.fn() }));

vi.mock("#public/channels/auth.js", () => ({ vercelOidc: () => verify }));

import { sameEnvironmentVercelOidc } from "#public/channels/same-environment-oidc.js";

const request = new Request("https://agent.example/webhook", { method: "POST" });

describe("sameEnvironmentVercelOidc", () => {
  beforeEach(() => {
    verify.mockReset();
  });

  it("accepts a token from this project's current environment", async () => {
    const auth = { principalType: "runtime", subject: "prj" };
    verify.mockResolvedValue(auth);

    await expect(sameEnvironmentVercelOidc()(request)).resolves.toBe(auth);
  });

  it.each([
    ["another environment of this project", { principalType: "service", subject: "prj" }],
    ["a user token", { principalType: "user", subject: "user" }],
    ["a missing or invalid token", null],
  ])("rejects %s", async (_name, auth) => {
    verify.mockResolvedValue(auth);

    await expect(sameEnvironmentVercelOidc()(request)).resolves.toBeNull();
  });
});
