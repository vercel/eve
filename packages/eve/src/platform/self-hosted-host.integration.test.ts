import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { hostCapabilities } from "#platform/capabilities.js";
import type { PlatformContext } from "#platform/context.js";
import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";
import { createEveRuntime, installEveRuntime } from "#runtime/eve-runtime.js";

const config = {
  publicUrl: "https://agents.internal.example.com",
  deploymentId: "build-2026-11-20.3",
  build: { deployedAt: "2026-11-20T00:00:00.000Z", gitBranch: "main", gitSha: "abc1234" },
  gatewayApiKey: "host-provided-key",
};
const publicHost = new URL(config.publicUrl).host;
const documentStore: MemoryDocumentBackend = { kind: "self-hosted-documents" } as never;

const selfHostedPlatform: PlatformContext = {
  build: {
    target: () => "node",
    outputDirectory: () => undefined,
    localSandboxPrewarmFailure: () => undefined,
  },
  capabilities: hostCapabilities("1", { documentStore: true, modelCredentials: true }),
  deployment: {
    environmentKind: () => "production",
    deploymentId: () => config.deploymentId,
    hostedDeploymentId: () => config.deploymentId,
    build: () => config.build,
    productionHost: () => publicHost,
    deploymentHost: () => publicHost,
    publicHost: () => publicHost,
    isPlatformDevelopmentServer: () => false,
    scope: () => ({
      environment: "production",
      id: "agents-prod",
      platform: "self-hosted",
      variant: null,
    }),
  },
  hooks: {
    documentStore: () => documentStore,
    modelCredentials: async () => ({ kind: "api-key", token: config.gatewayApiKey }),
  },
  identity: {
    token: async () => {
      throw new Error("this host has no workload identity");
    },
    isPlatformIssuer: () => false,
    withDevelopmentRequestScope: async (_input, callback) => await callback(),
    callbackHeaders: () => ({}),
  },
  telemetry: { traceSessionAttribute: () => undefined },
  workspace: {
    transport: (routePath) => ({
      url: `${config.publicUrl}${routePath}`,
      auth: async () => ({ headers: {} }),
    }),
  },
};

let uninstall: () => void;
beforeAll(() => {
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("VERCEL_PROJECT_ID", "prj_vercel_should_not_be_used");
  vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_vercel_should_not_be_used");
  vi.stubEnv("VERCEL_URL", "vercel-should-not-be-used.vercel.app");
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "vercel-prod-should-not-be-used.vercel.app");
  const runtime = createEveRuntime();
  runtime.platform = selfHostedPlatform;
  uninstall = installEveRuntime(runtime);
});
afterAll(() => {
  uninstall();
  vi.unstubAllEnvs();
});

describe("a self-hosted host installed in code", () => {
  it("supplies the runtime identity's build", async () => {
    const { buildRuntimeIdentity } = await import("#execution/node-step.js");
    expect(buildRuntimeIdentity({ id: "agent", name: "agent" }).build).toEqual(config.build);
  });

  it("supplies the public host for gateway attribution", async () => {
    const { buildGatewayAttributionHeaders } = await import("#harness/model-call/model.js");
    expect(
      buildGatewayAttributionHeaders({ gateway: true } as never, undefined)?.["http-referer"],
    ).toBe(config.publicUrl);
  });

  it("supplies the production callback base URL", async () => {
    const { resolveVercelProductionCallbackBaseUrl } =
      await import("#execution/workflow-callback-url.js");
    expect(resolveVercelProductionCallbackBaseUrl()).toContain(publicHost);
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

  it("provides the document store it declares", async () => {
    const { defaultDocumentBackend } = await import("#platform/document-store.js");
    expect(defaultDocumentBackend()).toBe(documentStore);
  });

  it("provides the model credentials it declares", async () => {
    const { gatewayCredential } = await import("#platform/models.js");
    await expect(gatewayCredential()).resolves.toEqual({
      kind: "api-key",
      token: config.gatewayApiKey,
    });
  });

  it("has no hosted sandbox, so eve never selects one", async () => {
    const { hasCapability } = await import("#platform/capabilities.js");
    const { hostedSandboxEnvironment } = await import("#platform/hosted-sandbox.js");
    expect(hasCapability(selfHostedPlatform, "hostedSandbox")).toBe(false);
    expect(() => hostedSandboxEnvironment()).toThrow("doesn't provide a hosted sandbox");
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
    expect(() => runtimeSpanProcessor()).toThrow("doesn't support Agent Runs");
  });

  it("routes workspace agents through its own transport", async () => {
    const { defineWorkspaceAgent } = await import("#public/definitions/workspace-agent.js");
    const agent = defineWorkspaceAgent({ name: "peer", description: "A peer agent." });
    const url = typeof agent.url === "function" ? await agent.url() : agent.url;
    expect(String(url)).toContain(publicHost);
  });
});
