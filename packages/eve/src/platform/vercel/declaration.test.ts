import { afterEach, describe, expect, it, vi } from "vitest";

import { createEntities, developmentIdentity, usesPlatformOutput } from "#platform/entities.js";
import vercelPlatform from "#platform/vercel/declaration.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function vercelEntities() {
  return createEntities(vercelPlatform, undefined);
}

describe("the Vercel platform declaration", () => {
  it("names the schedule provider kind that eve dev and deployments run", () => {
    vi.stubEnv("EVE_DEV", "");
    expect(vercelPlatform.build?.schedules?.kind).toBe("vercel");
    vi.stubEnv("EVE_DEV", "1");
    expect(vercelPlatform.build?.schedules?.kind).toBe("in-memory");
  });

  it("adds the Vercel deployment to invocation data only on Vercel", () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", " dpl_123 ");
    vi.stubEnv("VERCEL", "1");
    expect(vercelEntities().deployment.invocationData?.()).toEqual({
      vercelDeploymentId: "dpl_123",
    });

    vi.stubEnv("VERCEL", "");
    expect(vercelEntities().deployment.invocationData?.()).toEqual({});
  });

  it("reads Vercel at each use, not when it makes an entity", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", undefined);
    const { build, compute, telemetry } = vercelEntities();
    expect([compute?.selectByDefault, compute?.platformStopsSandboxes]).toEqual([false, false]);
    expect(telemetry.sessionAttribute).toBeUndefined();
    expect(usesPlatformOutput(build)).toBe(false);
    expect(build.outputDirectory).toBeUndefined();

    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect([compute?.selectByDefault, compute?.credentialTransforms]).toEqual([true, true]);
    expect(compute?.platformStopsSandboxes).toBe(true);
    expect(telemetry.sessionAttribute).toBe("vercel.session_id");
    expect(usesPlatformOutput(build)).toBe(true);
    expect(build.outputDirectory).toBe(".vercel/output");
  });

  it("keeps the development caller and scope of Vercel OIDC off the public identity", () => {
    const { identity } = vercelEntities();
    expect(Object.keys(identity)).toEqual(["verifyOidcCaller"]);
    expect(developmentIdentity(identity)).toMatchObject({
      caller: expect.any(Function),
      scope: expect.any(Function),
    });
  });
});
