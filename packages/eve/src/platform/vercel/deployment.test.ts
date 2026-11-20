import { afterEach, describe, expect, it, vi } from "vitest";

import { platformContext } from "#platform/context.js";
import { vercelEnvironmentName } from "#platform/vercel/deployment.js";

const deployment = () => platformContext().deployment;

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

  it("names the environment from the target environment before the environment kind", () => {
    vi.stubEnv("VERCEL_TARGET_ENV", " staging ");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(vercelEnvironmentName()).toBe("staging");

    vi.stubEnv("VERCEL_TARGET_ENV", "  ");
    expect(vercelEnvironmentName()).toBe("preview");
  });

  it("scopes a deployment to its project and environment, and a preview to its branch", () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    expect(deployment().scope()).toBeUndefined();

    vi.stubEnv("VERCEL_PROJECT_ID", "prj_123");
    vi.stubEnv("VERCEL_TARGET_ENV", "");
    vi.stubEnv("VERCEL_ENV", "");
    expect(deployment().scope()).toEqual({
      environment: "production",
      id: "prj_123",
      platform: "vercel",
      variant: null,
    });

    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", " dpl_9 ");
    expect(deployment().scope()?.variant).toBe("dpl_9");

    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "feature-x");
    expect(deployment().scope()?.variant).toBe("feature-x");
  });

  it("counts only vercel dev, not a pulled VERCEL_ENV, as the platform development server", () => {
    vi.stubEnv("VERCEL_ENV", "development");
    vi.stubEnv("VERCEL", "");
    expect(deployment().isPlatformDevelopmentServer()).toBe(false);

    vi.stubEnv("VERCEL", "1");
    expect(deployment().isPlatformDevelopmentServer()).toBe(true);
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
