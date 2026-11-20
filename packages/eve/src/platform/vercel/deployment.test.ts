import { afterEach, describe, expect, it, vi } from "vitest";

import { currentPlatform } from "#platform/current.js";

const deployment = () => currentPlatform().deployment;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Vercel platform deployment facts", () => {
  it("reports only the development, preview, and production environment kinds", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(deployment().environmentKind()).toBe("preview");

    vi.stubEnv("VERCEL_ENV", "staging");
    expect(deployment().environmentKind()).toBeUndefined();

    vi.stubEnv("VERCEL_ENV", "");
    expect(deployment().environmentKind()).toBeUndefined();
  });

  it("trims the deployment id and treats a blank one as absent", () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "  dpl_123  ");
    expect(deployment().deploymentId()).toBe("dpl_123");

    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "   ");
    expect(deployment().deploymentId()).toBeUndefined();
  });

  it("reports build identity only when one of its fields is set", () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "   ");
    vi.stubEnv("VERCEL_DEPLOYMENT_CREATED_AT", "");
    expect(deployment().build()).toBeUndefined();

    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", " abc123 ");
    expect(deployment().build()).toStrictEqual({
      deployedAt: undefined,
      gitBranch: undefined,
      gitSha: "abc123",
    });
  });

  it("prefers the production host over the deployment host", () => {
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "agent.example.com");
    vi.stubEnv("VERCEL_URL", "agent-git-main.vercel.app");
    expect(deployment().publicHost()).toBe("agent.example.com");

    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    expect(deployment().publicHost()).toBe("agent-git-main.vercel.app");

    vi.stubEnv("VERCEL_URL", "");
    expect(deployment().publicHost()).toBeUndefined();
  });
});
