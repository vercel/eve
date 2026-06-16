import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildAgentInfoResponseFromManifest: vi.fn(() => ({ kind: "eve-agent-info", version: 1 })),
  loadAgentInfoManifestData: vi.fn(async () => ({ manifest: {}, schedules: [] })),
  localDev: vi.fn(() => "local-dev-auth"),
  resolveAgentInfoCompiledArtifactsSource: vi.fn(() => ({
    appRoot: "/tmp/app/.eve/dev-runtime/snapshots/current/app",
    kind: "disk" as const,
  })),
  routeAuth: vi.fn(async () => ({ principal: "local-dev" })),
  vercelOidc: vi.fn(() => "vercel-oidc-auth"),
}));

vi.mock("#internal/nitro/routes/agent-info/build-agent-info-response-from-manifest.js", () => ({
  buildAgentInfoResponseFromManifest: mocks.buildAgentInfoResponseFromManifest,
}));

vi.mock("#internal/nitro/routes/agent-info/load-agent-info-data.js", () => ({
  loadAgentInfoManifestData: mocks.loadAgentInfoManifestData,
  resolveAgentInfoCompiledArtifactsSource: mocks.resolveAgentInfoCompiledArtifactsSource,
}));

vi.mock("#public/channels/auth.js", () => ({
  localDev: mocks.localDev,
  routeAuth: mocks.routeAuth,
  vercelOidc: mocks.vercelOidc,
}));

describe("handleAgentInfoRequest", () => {
  it("resolves info from the dev runtime artifact source", async () => {
    // Determinism: the route reads gateway credentials from process.env.
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    const { handleAgentInfoRequest } = await import("#internal/nitro/routes/info.js");

    const response = await handleAgentInfoRequest(
      {
        appRoot: "/tmp/app",
        dev: true,
        devRuntimeArtifactsPointerPath: "/tmp/app/.eve/dev-runtime/current.json",
        mode: "development",
        moduleMapLoaderPath: "/tmp/eve/src/internal/authored-module-map-loader.ts",
      },
      new Request("http://127.0.0.1/eve/v1/info"),
    );

    expect(response.status).toBe(200);
    expect(mocks.resolveAgentInfoCompiledArtifactsSource).toHaveBeenCalledWith({
      appRoot: "/tmp/app",
      dev: true,
      devRuntimeArtifactsPointerPath: "/tmp/app/.eve/dev-runtime/current.json",
      mode: "development",
      moduleMapLoaderPath: "/tmp/eve/src/internal/authored-module-map-loader.ts",
    });
    expect(mocks.loadAgentInfoManifestData).toHaveBeenCalledWith({
      compiledArtifactsSource: {
        appRoot: "/tmp/app/.eve/dev-runtime/snapshots/current/app",
        kind: "disk",
      },
    });
    expect(mocks.buildAgentInfoResponseFromManifest).toHaveBeenCalledWith(
      {
        manifest: {},
        schedules: [],
      },
      {
        mode: "development",
        gatewayCredentials: { apiKey: false, oidc: false },
      },
    );
    vi.unstubAllEnvs();
  });
});
