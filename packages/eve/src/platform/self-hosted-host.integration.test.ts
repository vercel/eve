import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { bindApp } from "#context/app.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { definePlatform } from "#platform/declaration.js";
import { createEntities } from "#platform/entities.js";
import { inTestApp, testApp } from "#internal/testing/test-platform.js";
import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";
import type { App } from "#runtime/app.js";

const config = {
  publicUrl: "https://agents.internal.example.com",
  deploymentId: "build-2026-11-20.3",
  revision: { deployedAt: "2026-11-20T00:00:00.000Z", gitBranch: "main", gitSha: "abc1234" },
  gatewayApiKey: "host-provided-key",
};
const publicHost = new URL(config.publicUrl).host;
const documentStore: MemoryDocumentBackend = { kind: "self-hosted-documents" } as never;

const selfHostedPlatform = definePlatform({
  deployment: () => ({
    environment: () => "production",
    deploymentId: () => config.deploymentId,
    revision: () => config.revision,
    host: () => publicHost,
    scope: () => ({
      environment: "production",
      id: "agents-prod",
      platform: "self-hosted",
      variant: null,
    }),
  }),
  storage: () => ({ documents: documentStore }),
  models: () => ({ resolve: async () => ({ kind: "api-key", token: config.gatewayApiKey }) }),
});

const platform = createEntities(selfHostedPlatform, undefined);

beforeAll(() => {
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("VERCEL_PROJECT_ID", "prj_vercel_should_not_be_used");
  vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_vercel_should_not_be_used");
  vi.stubEnv("VERCEL_URL", "vercel-should-not-be-used.vercel.app");
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "vercel-prod-should-not-be-used.vercel.app");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

describe("a self-hosted platform given to eve", () => {
  it("supplies the runtime identity's build from its revision", async () => {
    const { buildRuntimeIdentity } = await import("#execution/node-step.js");
    expect(buildRuntimeIdentity({ id: "agent", name: "agent" }, platform).build).toEqual(
      config.revision,
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

  it("keys default memory namespaces by the deployment scope of the turn's app", async () => {
    const { defaultNamespace } = await import("#public/memory/index.js");
    const turn = new ContextContainer();
    bindApp(turn, { platform } as App);
    const namespace = contextStorage.run(turn, () =>
      defaultNamespace({ appRoot: "/srv/app", node: "agent", slot: "notes" }),
    );
    expect(JSON.parse(namespace)).toEqual([
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
    expect(defaultDocumentBackend(platform)).toBe(documentStore);
  });

  it("provides its own model credentials", async () => {
    const { gatewayCredential } = await import("#platform/models.js");
    await expect(gatewayCredential(platform)).resolves.toEqual({
      kind: "api-key",
      token: config.gatewayApiKey,
    });
  });

  it("has no hosted sandbox, so eve never selects one", async () => {
    const { hostedSandboxEnvironment } = await import("#platform/hosted-sandbox.js");
    const { hostedCompute } = await import("#sandbox/hosted-compute.js");
    const compute = inTestApp(() => hostedCompute(), testApp({ platform }));
    expect(compute).toBeUndefined();
    expect(() => hostedSandboxEnvironment(compute)).toThrow("has no hosted sandbox");
  });

  it("asks for an explicit schedules provider", async () => {
    const { defaultScheduleProvider } = await import("#platform/schedules.js");
    expect(() => defaultScheduleProvider(platform)).toThrow(
      "Pass `provider` to defineDynamicSchedules()",
    );
  });

  it("doesn't export Agent Runs", async () => {
    const { exportsAgentRuns, runtimeSpanProcessor } = await import("#platform/runtime-spans.js");
    expect(exportsAgentRuns(platform)).toBe(false);
    expect(() => runtimeSpanProcessor(platform)).toThrow("doesn't export Agent Runs");
  });
});
