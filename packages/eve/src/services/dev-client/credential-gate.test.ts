import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveVercelDeployment } from "#setup/vercel-deployment.js";
import type { VercelCaptureResult } from "#setup/primitives/index.js";

import { createDevelopmentCredentialGate } from "./credential-gate.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function verifiedTarget(host: string) {
  const captureResult: VercelCaptureResult = {
    ok: true,
    stdout: JSON.stringify({
      customEnvironment: null,
      name: "verified-project",
      projectId: "prj_verified",
      target: "preview",
    }),
  };
  const result = await resolveVercelDeployment({
    deps: {
      captureVercel: vi.fn(async () => captureResult),
    },
    host,
    ownerId: "team_verified",
    workspaceRoot: "/workspace",
  });
  if (result.kind !== "resolved") {
    throw new Error(`Expected a verified target, received ${result.kind}.`);
  }
  return result.target;
}

describe("createDevelopmentCredentialGate", () => {
  it("stays anonymous until an authoritative target is installed", async () => {
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "ambient-bypass");
    const gate = createDevelopmentCredentialGate("https://verified.example.com/path");

    expect(gate.current()).toEqual({ kind: "anonymous" });
    await expect(gate.resolveHeaders()).resolves.toEqual({});

    const target = await verifiedTarget("verified.example.com");
    gate.authorize({ target, token: " oidc-token " });

    expect(gate.current()).toEqual({ kind: "vercel", target });
    await expect(gate.resolveHeaders()).resolves.toEqual({
      authorization: "Bearer oidc-token",
      "x-vercel-protection-bypass": "ambient-bypass",
      "x-vercel-trusted-oidc-idp-token": "oidc-token",
    });
  });

  it("rejects authority for a different origin without replacing current authority", async () => {
    const gate = createDevelopmentCredentialGate("https://verified.example.com");
    const target = await verifiedTarget("verified.example.com");
    const otherTarget = await verifiedTarget("other.example.com");
    gate.authorize({ target, token: "first-token" });

    expect(() => gate.authorize({ target: otherTarget, token: "other-token" })).toThrow(
      "does not match",
    );
    await expect(gate.resolveHeaders()).resolves.toMatchObject({
      authorization: "Bearer first-token",
    });
  });

  it("permits an automation bypass only after origin verification", async () => {
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "verified-bypass");
    const gate = createDevelopmentCredentialGate("https://verified.example.com");
    await expect(gate.resolveHeaders()).resolves.toEqual({});

    gate.authorize({
      target: await verifiedTarget("verified.example.com"),
      token: "",
    });

    await expect(gate.resolveHeaders()).resolves.toEqual({
      "x-vercel-protection-bypass": "verified-bypass",
    });
  });
});
