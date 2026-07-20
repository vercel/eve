import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildAgentInfoResponseFromManifest: vi.fn(() => ({ kind: "eve-agent-info", version: 1 })),
  getVercelOidcToken: vi.fn(),
  loadAgentInfoManifestData: vi.fn(async () => ({
    manifest: {
      config: {
        model: {
          routing: { kind: "gateway", target: "openai" },
        },
      },
    },
    schedules: [],
  })),
  resolveAgentInfoCompiledArtifactsSource: vi.fn(() => ({
    appRoot: "/tmp/app/.eve/dev-runtime/snapshots/current/app",
    kind: "disk" as const,
  })),
}));

vi.mock("#compiled/@vercel/oidc/index.js", () => ({
  getVercelOidcToken: mocks.getVercelOidcToken,
}));

vi.mock("#internal/nitro/routes/agent-info/build-agent-info-response-from-manifest.js", () => ({
  buildAgentInfoResponseFromManifest: mocks.buildAgentInfoResponseFromManifest,
}));

vi.mock("#internal/nitro/routes/agent-info/load-agent-info-data.js", () => ({
  loadAgentInfoManifestData: mocks.loadAgentInfoManifestData,
  resolveAgentInfoCompiledArtifactsSource: mocks.resolveAgentInfoCompiledArtifactsSource,
}));

const ROUTE_INPUT = {
  appRoot: "/tmp/app",
  devRuntimeArtifactsPointerPath: "/tmp/app/.eve/dev-runtime/current.json",
  kind: "development",
  moduleMapLoaderPath: "/tmp/eve/src/internal/authored-module-map-loader.ts",
} as const;

const GATEWAY_MANIFEST_DATA = {
  manifest: {
    config: {
      model: {
        routing: { kind: "gateway" as const, target: "openai" },
      },
    },
  },
  schedules: [],
};

async function requestAgentInfo(): Promise<Response> {
  const { handleAgentInfoRequest } = await import("#internal/nitro/routes/info.js");

  return await handleAgentInfoRequest(ROUTE_INPUT);
}

describe("handleAgentInfoRequest", () => {
  beforeEach(() => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    mocks.buildAgentInfoResponseFromManifest.mockClear();
    mocks.getVercelOidcToken.mockReset();
    mocks.getVercelOidcToken.mockRejectedValue(new Error("not linked"));
    mocks.loadAgentInfoManifestData.mockReset();
    mocks.loadAgentInfoManifestData.mockResolvedValue(GATEWAY_MANIFEST_DATA);
    mocks.resolveAgentInfoCompiledArtifactsSource.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves info from the dev runtime artifact source", async () => {
    const response = await requestAgentInfo();

    expect(response.status).toBe(200);
    expect(mocks.resolveAgentInfoCompiledArtifactsSource).toHaveBeenCalledWith(ROUTE_INPUT);
    expect(mocks.loadAgentInfoManifestData).toHaveBeenCalledWith({
      compiledArtifactsSource: {
        appRoot: "/tmp/app/.eve/dev-runtime/snapshots/current/app",
        kind: "disk",
      },
    });
    expect(mocks.buildAgentInfoResponseFromManifest).toHaveBeenCalledWith(GATEWAY_MANIFEST_DATA, {
      mode: "development",
      gatewayCredentials: { apiKey: false, oidc: false },
    });
    expect(mocks.getVercelOidcToken).toHaveBeenCalledOnce();
  });

  it("reports linked-project OIDC resolved by the Vercel SDK", async () => {
    mocks.getVercelOidcToken.mockResolvedValue("linked-project-token");

    const response = await requestAgentInfo();

    expect(response.status).toBe(200);
    expect(mocks.buildAgentInfoResponseFromManifest).toHaveBeenCalledWith(GATEWAY_MANIFEST_DATA, {
      mode: "development",
      gatewayCredentials: { apiKey: false, oidc: true },
    });
    expect(mocks.getVercelOidcToken).toHaveBeenCalledOnce();
  });

  it("does not resolve OIDC when an AI Gateway API key is present", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-key");

    const response = await requestAgentInfo();

    expect(response.status).toBe(200);
    expect(mocks.buildAgentInfoResponseFromManifest).toHaveBeenCalledWith(GATEWAY_MANIFEST_DATA, {
      mode: "development",
      gatewayCredentials: { apiKey: true, oidc: false },
    });
    expect(mocks.getVercelOidcToken).not.toHaveBeenCalled();
  });
});
