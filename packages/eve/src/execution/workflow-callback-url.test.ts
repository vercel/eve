import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWorkflowCallbackUrl,
  resolveVercelProductionCallbackBaseUrl,
} from "#execution/workflow-callback-url.js";

describe("resolveVercelProductionCallbackBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null outside production", () => {
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "agent.example.com");
    vi.stubEnv("VERCEL_ENV", "preview");

    expect(resolveVercelProductionCallbackBaseUrl()).toBeNull();
  });

  it("uses the project production URL in production", () => {
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "agent.example.com");
    vi.stubEnv("VERCEL_ENV", "production");

    expect(resolveVercelProductionCallbackBaseUrl()).toBe("https://agent.example.com");
  });

  it("adds the Vercel automation bypass query param when configured", () => {
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "secret value");

    expect(
      createWorkflowCallbackUrl("https://agent.example.com", "/eve/v1/callback/eve%3Aparent-token"),
    ).toBe(
      "https://agent.example.com/eve/v1/callback/eve%3Aparent-token?x-vercel-protection-bypass=secret+value",
    );
  });

  it("preserves existing callback query params when adding the Vercel bypass query param", () => {
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "secret");

    expect(
      createWorkflowCallbackUrl(
        "https://agent.example.com",
        "/eve/v1/connections/linear/callback/tok123?code=abc",
      ),
    ).toBe(
      "https://agent.example.com/eve/v1/connections/linear/callback/tok123?code=abc&x-vercel-protection-bypass=secret",
    );
  });
});
