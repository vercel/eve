import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("BETTER_AUTH_URL", "");
  vi.stubEnv("DATABASE_URL", "postgresql://user:password@example.com/database");
  vi.stubEnv("KERNEL_API_KEY", "test-kernel-key");
  vi.stubEnv("VERCEL_BRANCH_URL", "");
  vi.stubEnv("VERCEL_ENV", undefined);
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
  vi.stubEnv("VERCEL_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("application origin", () => {
  it("uses an explicit origin outside Vercel", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://assistant.example/path");

    const { applicationOrigin, betterAuthBaseURL } =
      await import("@shared/environment/origin");

    expect(applicationOrigin()).toBe("https://assistant.example");
    expect(betterAuthBaseURL()).toBe("https://assistant.example");
  });

  it("derives the production origin and preview allowlist from Vercel", async () => {
    vi.stubEnv("VERCEL_BRANCH_URL", "openinstinct-git-main.vercel.app");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "openinstinct.example.com");
    vi.stubEnv("VERCEL_URL", "openinstinct-preview-123.vercel.app");

    const { applicationOrigin, betterAuthBaseURL } =
      await import("@shared/environment/origin");

    expect(applicationOrigin()).toBe("https://openinstinct.example.com");
    expect(betterAuthBaseURL()).toEqual({
      allowedHosts: [
        "*.vercel.app",
        "openinstinct.example.com",
        "openinstinct-git-main.vercel.app",
        "openinstinct-preview-123.vercel.app",
      ],
      fallback: "https://openinstinct.example.com",
      protocol: "https",
    });
  });

  it("fails clearly when a non-Vercel production host has no URL", async () => {
    vi.stubEnv("VERCEL_URL", "stale-preview.vercel.app");

    const { applicationOrigin } = await import("@shared/environment/origin");

    expect(() => applicationOrigin()).toThrow("Set BETTER_AUTH_URL");
  });
});
