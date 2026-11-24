import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWorkflowCallbackUrl,
  resolveVercelProductionCallbackBaseUrl,
  resolveWorkflowCallbackBaseUrl,
} from "#execution/workflow-callback-url.js";
import { createEntities } from "#platform/entities.js";
import vercelPlatform from "#platform/vercel/declaration.js";
import { runInApp } from "#context/app.js";
import type { App } from "#runtime/app.js";

const platform = createEntities(vercelPlatform, undefined);

describe("resolveVercelProductionCallbackBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null outside production", () => {
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "agent.example.com");
    vi.stubEnv("VERCEL_ENV", "preview");

    expect(resolveVercelProductionCallbackBaseUrl(platform)).toBeNull();
  });

  it("uses the project production URL in production", () => {
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "agent.example.com");
    vi.stubEnv("VERCEL_ENV", "production");

    expect(resolveVercelProductionCallbackBaseUrl(platform)).toBe("https://agent.example.com");
  });

  it("keeps the Vercel automation bypass secret out of callback URLs", () => {
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "secret value");

    expect(
      createWorkflowCallbackUrl("https://agent.example.com", "/eve/v1/callback/eve%3Aparent-token"),
    ).toBe("https://agent.example.com/eve/v1/callback/eve%3Aparent-token");
  });

  it("preserves callback query params without adding deployment credentials", () => {
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "secret");

    expect(
      createWorkflowCallbackUrl(
        "https://agent.example.com",
        "/eve/v1/connections/linear/callback/tok123?code=abc",
      ),
    ).toBe("https://agent.example.com/eve/v1/connections/linear/callback/tok123?code=abc");
  });
});

describe("resolveWorkflowCallbackBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses workflow metadata when no callback override is configured", () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("WORKFLOW_LOCAL_BASE_URL", "");

    expect(resolveWorkflowCallbackBaseUrl("http://localhost:3000/", platform)).toBe(
      "http://localhost:3000",
    );
  });

  it("prefers the active local world base URL and removes its trailing slash", () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("WORKFLOW_LOCAL_BASE_URL", "http://127.0.0.1:2000/");

    expect(resolveWorkflowCallbackBaseUrl("http://localhost:3000", platform)).toBe(
      "http://127.0.0.1:2000",
    );
  });

  it("prefers the stable Vercel production URL over a local world override", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "agent.example.com");
    vi.stubEnv("WORKFLOW_LOCAL_BASE_URL", "http://127.0.0.1:2000");

    expect(resolveWorkflowCallbackBaseUrl("https://deployment.example.com", platform)).toBe(
      "https://agent.example.com",
    );
  });

  it("appends the configured public route prefix to the resolved base", () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("WORKFLOW_LOCAL_BASE_URL", "");
    vi.stubEnv("EVE_PUBLIC_ROUTE_PREFIX", "/eve/support");

    expect(resolveWorkflowCallbackBaseUrl("https://deployment.example.com/", platform)).toBe(
      "https://deployment.example.com/eve/support",
    );
  });

  it("appends the public route prefix to the stable Vercel production URL", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "agent.example.com");
    vi.stubEnv("EVE_PUBLIC_ROUTE_PREFIX", "eve/support/");

    expect(resolveWorkflowCallbackBaseUrl("https://deployment.example.com", platform)).toBe(
      "https://agent.example.com/eve/support",
    );
  });

  it("ignores a public route prefix resolving to the root route", () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("WORKFLOW_LOCAL_BASE_URL", "");
    vi.stubEnv("EVE_PUBLIC_ROUTE_PREFIX", "/");

    expect(resolveWorkflowCallbackBaseUrl("http://localhost:3000", platform)).toBe(
      "http://localhost:3000",
    );
  });
});

describe("createWorkflowCallbackUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preserves a public route prefix carried by the base URL", () => {
    expect(
      createWorkflowCallbackUrl(
        "https://agent.example.com/eve/support",
        "/eve/v1/callback/eve%3Aparent-token",
      ),
    ).toBe("https://agent.example.com/eve/support/v1/callback/eve%3Aparent-token");
  });

  it("preserves the prefix without adding the Vercel bypass secret", () => {
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "secret");

    expect(
      createWorkflowCallbackUrl(
        "https://agent.example.com/eve/support",
        "/eve/v1/connections/linear/callback/tok123?code=abc",
      ),
    ).toBe("https://agent.example.com/eve/support/v1/connections/linear/callback/tok123?code=abc");
  });
});

describe("resolveWorkflowCallbackBaseUrl with one argument", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the metadata URL in a process with no app", () => {
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "agent.example.com");
    vi.stubEnv("VERCEL_ENV", "production");

    expect(resolveWorkflowCallbackBaseUrl("https://local.example.com/")).toBe(
      "https://local.example.com",
    );
  });

  it("uses the production host of the app's platform inside the app", () => {
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "agent.example.com");
    vi.stubEnv("VERCEL_ENV", "production");
    const app = { platform } as App;

    expect(runInApp(app, () => resolveWorkflowCallbackBaseUrl("https://local.example.com"))).toBe(
      "https://agent.example.com",
    );
  });
});
