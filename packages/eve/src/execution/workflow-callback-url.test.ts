import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWorkflowCallbackUrl,
  resolveVercelProductionCallbackBaseUrl,
  resolveWorkflowCallbackBaseUrl,
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

describe("resolveWorkflowCallbackBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses workflow metadata when no callback override is configured", () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("WORKFLOW_LOCAL_BASE_URL", "");

    expect(resolveWorkflowCallbackBaseUrl("http://localhost:3000/")).toBe("http://localhost:3000");
  });

  it("prefers the active local world base URL and removes its trailing slash", () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("WORKFLOW_LOCAL_BASE_URL", "http://127.0.0.1:2000/");

    expect(resolveWorkflowCallbackBaseUrl("http://localhost:3000")).toBe("http://127.0.0.1:2000");
  });

  it("prefers the stable Vercel production URL over a local world override", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "agent.example.com");
    vi.stubEnv("WORKFLOW_LOCAL_BASE_URL", "http://127.0.0.1:2000");

    expect(resolveWorkflowCallbackBaseUrl("https://deployment.example.com")).toBe(
      "https://agent.example.com",
    );
  });

  it("appends the configured public route prefix to the resolved base", () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("WORKFLOW_LOCAL_BASE_URL", "");
    vi.stubEnv("EVE_PUBLIC_ROUTE_PREFIX", "/eve/agents/support");

    expect(resolveWorkflowCallbackBaseUrl("https://deployment.example.com/")).toBe(
      "https://deployment.example.com/eve/agents/support",
    );
  });

  it("appends the public route prefix to the stable Vercel production URL", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "agent.example.com");
    vi.stubEnv("EVE_PUBLIC_ROUTE_PREFIX", "eve/agents/support/");

    expect(resolveWorkflowCallbackBaseUrl("https://deployment.example.com")).toBe(
      "https://agent.example.com/eve/agents/support",
    );
  });

  it("ignores a public route prefix resolving to the root route", () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("WORKFLOW_LOCAL_BASE_URL", "");
    vi.stubEnv("EVE_PUBLIC_ROUTE_PREFIX", "/");

    expect(resolveWorkflowCallbackBaseUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });
});

describe("createWorkflowCallbackUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preserves a public route prefix carried by the base URL", () => {
    expect(
      createWorkflowCallbackUrl(
        "https://agent.example.com/eve/agents/support",
        "/eve/v1/callback/eve%3Aparent-token",
      ),
    ).toBe("https://agent.example.com/eve/agents/support/eve/v1/callback/eve%3Aparent-token");
  });

  it("preserves the prefix when adding the Vercel bypass query param", () => {
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "secret");

    expect(
      createWorkflowCallbackUrl(
        "https://agent.example.com/eve/agents/support",
        "/eve/v1/connections/linear/callback/tok123?code=abc",
      ),
    ).toBe(
      "https://agent.example.com/eve/agents/support/eve/v1/connections/linear/callback/tok123?code=abc&x-vercel-protection-bypass=secret",
    );
  });
});
