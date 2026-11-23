import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { definePlatform } from "#platform/declaration.js";
import { createEntities } from "#platform/entities.js";
import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";
import { createProcessApp, installProcessApp } from "#runtime/app.js";

const config = {
  publicUrl: "https://agents.internal.example.com",
  deploymentId: "build-2026-11-20.3",
  build: { deployedAt: "2026-11-20T00:00:00.000Z", gitBranch: "main", gitSha: "abc1234" },
  gatewayApiKey: "host-provided-key",
};
const publicHost = new URL(config.publicUrl).host;
const documentStore: MemoryDocumentBackend = { kind: "self-hosted-documents" } as never;

const selfHostedPlatform = definePlatform({
  deployment: () => ({
    environment: () => "production",
    deploymentId: () => config.deploymentId,
    build: () => config.build,
    productionHost: () => publicHost,
    publicHost: () => publicHost,
    scope: () => ({
      environment: "production",
      id: "agents-prod",
      platform: "self-hosted",
      variant: null,
    }),
  }),
  network: () => ({
    peer: (routePath) => ({
      url: `${config.publicUrl}${routePath}`,
      auth: async () => ({ headers: {} }),
    }),
  }),
  storage: () => ({ documents: documentStore }),
  models: () => ({ resolve: async () => ({ kind: "api-key", token: config.gatewayApiKey }) }),
});

const platform = createEntities(selfHostedPlatform, undefined);

let uninstall: () => void;
beforeAll(() => {
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("VERCEL_PROJECT_ID", "prj_vercel_should_not_be_used");
  vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_vercel_should_not_be_used");
  vi.stubEnv("VERCEL_URL", "vercel-should-not-be-used.vercel.app");
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "vercel-prod-should-not-be-used.vercel.app");
  const app = createProcessApp();
  app.platform = platform;
  uninstall = installProcessApp(app);
});
afterAll(() => {
  uninstall();
  vi.unstubAllEnvs();
});

describe("a self-hosted host installed in code", () => {
  it("supplies the runtime identity's build", async () => {
    const { buildRuntimeIdentity } = await import("#execution/node-step.js");
    expect(buildRuntimeIdentity({ id: "agent", name: "agent" }, platform).build).toEqual(
      config.build,
    );
  });

  it("supplies the public host for gateway attribution", async () => {
    const { buildGatewayAttributionHeaders } = await import("#harness/model-call/model.js");
    expect(
      buildGatewayAttributionHeaders({ gateway: true } as never, undefined, platform)?.[
        "http-referer"
      ],
    ).toBe(config.publicUrl);
  });

  it("supplies the production callback base URL", async () => {
    const { resolveVercelProductionCallbackBaseUrl } =
      await import("#execution/workflow-callback-url.js");
    expect(resolveVercelProductionCallbackBaseUrl(platform)).toContain(publicHost);
  });

  it("reports a production deployment, not a local development server", async () => {
    const { isLocalDevelopmentServer, resolveInstrumentationEnvironment } =
      await import("#internal/application/dev-environment.js");
    expect(isLocalDevelopmentServer()).toBe(false);
    expect(resolveInstrumentationEnvironment()).toBe("production");
  });

  it("keys default memory namespaces by its own deployment scope", async () => {
    const { defaultNamespace } = await import("#public/memory/index.js");
    expect(
      JSON.parse(defaultNamespace({ appRoot: "/srv/app", node: "agent", slot: "notes" })),
    ).toEqual([
      "eve-memory-default-namespace-v1",
      "self-hosted",
      "agents-prod",
      "production",
      null,
      "agent",
      "notes",
    ]);
  });

  it("provides its own document store", async () => {
    const { defaultDocumentBackend } = await import("#platform/document-store.js");
    expect(defaultDocumentBackend()).toBe(documentStore);
  });

  it("provides its own model credentials", async () => {
    const { gatewayCredential } = await import("#platform/models.js");
    await expect(gatewayCredential()).resolves.toEqual({
      kind: "api-key",
      token: config.gatewayApiKey,
    });
  });

  it("has no hosted sandbox, so eve never selects one", async () => {
    const { hostedSandbox, hostedSandboxEnvironment } = await import("#platform/hosted-sandbox.js");
    expect(hostedSandbox()).toBeUndefined();
    expect(() => hostedSandboxEnvironment()).toThrow("has no hosted sandbox");
  });

  it("asks for an explicit schedules provider", async () => {
    const { defaultScheduleProvider } = await import("#platform/schedules.js");
    expect(() => defaultScheduleProvider()).toThrow("Pass `provider` to defineDynamicSchedules()");
  });

  it("doesn't export Agent Runs", async () => {
    const { seedInstrumentationProviders, getInstrumentationProviders } =
      await import("#instrumentation/providers.js");
    const { runtimeSpanProcessor } = await import("#platform/runtime-spans.js");
    seedInstrumentationProviders();
    expect(getInstrumentationProviders().map((provider) => provider.slot)).not.toContain(
      "agent-runs",
    );
    expect(() => runtimeSpanProcessor()).toThrow("doesn't export Agent Runs");
  });

  it("routes workspace agents through its own transport", async () => {
    const { defineWorkspaceAgent } = await import("#public/definitions/workspace-agent.js");
    const agent = defineWorkspaceAgent({ name: "peer", description: "A peer agent." });
    const url = typeof agent.url === "function" ? await agent.url() : agent.url;
    expect(String(url)).toContain(publicHost);
  });
});
