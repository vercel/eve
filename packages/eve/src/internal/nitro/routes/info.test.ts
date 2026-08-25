import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildAgentInfoResponse: vi.fn(() => ({ kind: "eve-agent-info", version: 3 })),
  getVercelOidcToken: vi.fn(),
  refreshChatGptState: vi.fn(async () => ({ kind: "ready" as const })),
  loadAgentInfoManifestData: vi.fn(async (): Promise<unknown> => ({
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

vi.mock("#public/models/openai/chatgpt/token-broker.js", () => ({
  getDefaultCodexTokenBroker: () => ({ refreshState: mocks.refreshChatGptState }),
}));

vi.mock("#internal/nitro/routes/agent-info/build-agent-info-response.js", () => ({
  buildAgentInfoResponse: mocks.buildAgentInfoResponse,
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

const CHATGPT_MANIFEST_DATA = {
  manifest: {
    config: {
      model: {
        routing: { kind: "external" as const, provider: "codex" },
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
    mocks.buildAgentInfoResponse.mockClear();
    mocks.getVercelOidcToken.mockReset();
    mocks.getVercelOidcToken.mockRejectedValue(new Error("not linked"));
    mocks.refreshChatGptState.mockClear();
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
    expect(mocks.buildAgentInfoResponse).toHaveBeenCalledWith(GATEWAY_MANIFEST_DATA, {
      mode: "development",
      gatewayCredentials: { apiKey: false, oidc: false },
    });
    expect(mocks.getVercelOidcToken).toHaveBeenCalledOnce();
  });

  it("reports linked-project OIDC resolved by the Vercel SDK", async () => {
    mocks.getVercelOidcToken.mockResolvedValue("linked-project-token");

    const response = await requestAgentInfo();

    expect(response.status).toBe(200);
    expect(mocks.buildAgentInfoResponse).toHaveBeenCalledWith(GATEWAY_MANIFEST_DATA, {
      mode: "development",
      gatewayCredentials: { apiKey: false, oidc: true },
    });
    expect(mocks.getVercelOidcToken).toHaveBeenCalledOnce();
  });

  it("does not resolve OIDC when an AI Gateway API key is present", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-key");

    const response = await requestAgentInfo();

    expect(response.status).toBe(200);
    expect(mocks.buildAgentInfoResponse).toHaveBeenCalledWith(GATEWAY_MANIFEST_DATA, {
      mode: "development",
      gatewayCredentials: { apiKey: true, oidc: false },
    });
    expect(mocks.getVercelOidcToken).not.toHaveBeenCalled();
  });

  it("preflights ChatGPT auth for Codex-backed models", async () => {
    mocks.loadAgentInfoManifestData.mockResolvedValue(CHATGPT_MANIFEST_DATA);

    const response = await requestAgentInfo();

    expect(response.status).toBe(200);
    expect(mocks.refreshChatGptState).toHaveBeenCalledOnce();
    expect(mocks.buildAgentInfoResponse).toHaveBeenCalledWith(CHATGPT_MANIFEST_DATA, {
      mode: "development",
      gatewayCredentials: { apiKey: false, oidc: false },
      chatgptAuth: { kind: "ready" },
    });
    expect(mocks.getVercelOidcToken).not.toHaveBeenCalled();
  });
});
