import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { WizardCancelledError } from "#setup/step.js";
const mocks = vi.hoisted(() => ({
  readSelection: vi.fn(),
  team: vi.fn(),
  readDefault: vi.fn(),
  readSecret: vi.fn(),
  writeSecret: vi.fn(),
  writeSelection: vi.fn(),
  writeDefault: vi.fn(),
  inspect: vi.fn(),
  change: vi.fn(),
  cli: vi.fn(),
  validate: vi.fn(),
  session: vi.fn(),
  chatgpt: vi.fn(),
  chatgptState: vi.fn(),
  oauth: vi.fn(),
  models: vi.fn(),
  gateway: vi.fn(),
}));
vi.mock("#setup/provider-settings.js", () => ({
  readProviderSelection: mocks.readSelection,
  readProviderTeamSync: mocks.team,
  readProviderKeySourceSync: vi.fn(),
  writeProviderSelection: mocks.writeSelection,
  resolveAvailableProviders: vi.fn(async () => []),
}));
vi.mock("#internal/model-auth/store.js", async (original) => ({
  ...(await original<typeof import("#internal/model-auth/store.js")>()),
  readDefaultConnection: mocks.readDefault,
  readModelSecret: mocks.readSecret,
  writeModelSecret: mocks.writeSecret,
  writeDefaultConnection: mocks.writeDefault,
}));
vi.mock("#services/inspect-application.js", () => ({ inspectApplication: mocks.inspect }));
vi.mock("./model-source-change.js", () => ({ changeAgentModel: mocks.change }));
vi.mock("#internal/model-auth/vercel-cli.js", () => ({ readVercelCliConnection: mocks.cli }));
vi.mock("#internal/model-auth/vercel.js", () => ({
  authJson: mocks.models,
  resolveVercelSession: mocks.session,
  validateVercelAccess: mocks.validate,
}));
vi.mock("./chatgpt-auth.js", () => ({ ensureChatGptAuth: mocks.chatgpt }));
vi.mock("./vercel-model-login.js", () => ({ loginVercelModel: mocks.oauth }));
vi.mock("#public/models/openai/chatgpt/token-broker.js", () => ({
  getDefaultCodexTokenBroker: () => ({
    refreshState: mocks.chatgptState,
    getToken: async () => ({ token: "chat-token" }),
  }),
}));
vi.mock("../boxes/select-model.js", () => ({
  fetchGatewayCatalog: async () => [{ id: "openai/gpt-5.6-luna-fast", type: "language" }],
}));
vi.mock("#setup/validate-gateway-key.js", () => ({ validateGatewayApiKey: mocks.gateway }));
import { environmentConnection, runModelLogin } from "./model-login.js";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("EVE_DEV", "1");
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "AI_GATEWAY_API_KEY",
    "VERCEL_OIDC_TOKEN",
  ])
    vi.stubEnv(key, "");
  mocks.inspect.mockResolvedValue({
    compiledState: {
      manifest: {
        config: {
          model: { id: "openai/gpt-5.6-luna-fast", routing: { kind: "gateway", target: "openai" } },
        },
      },
    },
  });
  vi.stubEnv("EVE_MODEL_TEAM", undefined);
  vi.stubEnv("EVE_MODEL_KEY_SOURCE", undefined);
  vi.stubEnv("EVE_MODEL_CONNECTION", undefined);
  mocks.session.mockResolvedValue({ accessToken: "access", teamId: "team_123", teamName: "Alice" });
  mocks.change.mockResolvedValue({ kind: "changed" });
  mocks.readSecret.mockResolvedValue("stored-key");
  mocks.models.mockResolvedValue({
    data: [{ id: "gpt-5.6-luna-fast" }, { id: "claude-sonnet-5" }],
    models: [{ slug: "gpt-5.6-luna-fast" }],
  });
  mocks.gateway.mockResolvedValue({ kind: "valid" });
  mocks.chatgptState.mockResolvedValue({ kind: "ready" });
});

describe("model login", () => {
  it.each(["chatgpt", "vercel", "ai-gateway-key", "openai", "anthropic"])(
    "connects %s and returns directly to chat",
    async (selected) => {
      const fake = createFakePrompter({ single: () => selected, password: () => "new-key" });
      expect(await runModelLogin({ appRoot: "/agent", prompter: fake.prompter })).toEqual({
        kind: "ready",
      });
      expect(fake.selectMessages).toEqual(["Connect a model"]);
      expect(mocks.writeSelection.mock.calls[0]?.slice(0, 2)).toEqual(["/agent", selected]);
      expect(mocks.writeDefault).toHaveBeenCalledWith(selected);
      if (["openai", "anthropic", "ai-gateway-key"].includes(selected))
        expect(mocks.writeSecret).toHaveBeenCalledWith(
          selected === "ai-gateway-key" ? selected : `${selected}-key`,
          "new-key",
        );
      if (selected === "vercel") expect(mocks.oauth).toHaveBeenCalledOnce();
      if (selected === "chatgpt") expect(mocks.chatgpt).toHaveBeenCalledOnce();
    },
  );
  it("reuses the CLI team without any prompts or project linking", async () => {
    mocks.cli.mockResolvedValue({ token: "cli-token", teamId: "team_123" });
    const fake = createFakePrompter();
    expect(
      await runModelLogin({ appRoot: "/agent", prompter: fake.prompter, automatic: true }),
    ).toEqual({ kind: "ready" });
    expect(fake.selectMessages).toEqual([]);
    expect(mocks.validate).toHaveBeenCalledWith("cli-token", "team_123", undefined);
    expect(mocks.writeSecret).not.toHaveBeenCalled();
  });
  it("keeps project selection ahead of environment and machine preferences", async () => {
    mocks.readSelection.mockResolvedValue("chatgpt");
    vi.stubEnv("AI_GATEWAY_API_KEY", "explicit-key");
    mocks.readDefault.mockResolvedValue("vercel");
    await runModelLogin({
      appRoot: "/agent",
      prompter: createFakePrompter().prompter,
      automatic: true,
    });
    expect(mocks.writeSelection).toHaveBeenCalledWith("/agent", "chatgpt", undefined, undefined);
    expect(mocks.cli).not.toHaveBeenCalled();
  });
  it("returns to the composer on cancellation without replacing a broken explicit connection", async () => {
    mocks.readSelection.mockResolvedValue("vercel");
    mocks.session.mockRejectedValue(new Error("expired"));
    const fake = createFakePrompter({
      single: () => {
        throw new WizardCancelledError();
      },
    });
    expect(
      await runModelLogin({ appRoot: "/agent", prompter: fake.prompter, automatic: true }),
    ).toEqual({ kind: "cancelled" });
    expect(mocks.cli).not.toHaveBeenCalled();
    expect(mocks.writeSelection).not.toHaveBeenCalled();
  });
  it("does not save a rejected key", async () => {
    mocks.gateway.mockResolvedValue({ kind: "invalid" });
    let calls = 0;
    const fake = createFakePrompter({
      single: () => {
        if (calls++) throw new WizardCancelledError();
        return "ai-gateway-key";
      },
      password: () => "bad-key",
    });
    expect(await runModelLogin({ appRoot: "/agent", prompter: fake.prompter })).toEqual({
      kind: "cancelled",
    });
    expect(mocks.writeSecret).not.toHaveBeenCalled();
  });
  it("asks for an available model if the preferred model is unavailable", async () => {
    mocks.models.mockResolvedValue({ data: [{ id: "available-model" }] });
    const answers = ["openai", "available-model"];
    const fake = createFakePrompter({ single: () => answers.shift()!, password: () => "new-key" });
    await runModelLogin({ appRoot: "/agent", prompter: fake.prompter });
    expect(mocks.change).toHaveBeenCalledWith({
      appRoot: "/agent",
      slug: "openai-api/available-model",
    });
  });
  it("reuses the machine default without a connection picker", async () => {
    mocks.readDefault.mockResolvedValue("chatgpt");
    const fake = createFakePrompter();
    expect(
      await runModelLogin({ appRoot: "/agent", prompter: fake.prompter, automatic: true }),
    ).toEqual({ kind: "ready" });
    expect(fake.selectMessages).toEqual([]);
    expect(mocks.cli).not.toHaveBeenCalled();
  });
  it("preserves the project's team when the CLI has switched teams", async () => {
    mocks.readSelection.mockResolvedValue("vercel-cli");
    mocks.team.mockReturnValue({ teamId: "team_project", teamName: "Project team" });
    mocks.cli.mockResolvedValue({ token: "cli-token", teamId: "team_other" });
    vi.stubEnv("EVE_MODEL_TEAM", "team_project");
    const fake = createFakePrompter();
    expect(
      await runModelLogin({ appRoot: "/agent", prompter: fake.prompter, automatic: true }),
    ).toEqual({ kind: "ready" });
    expect(mocks.validate).toHaveBeenCalledWith("cli-token", "team_project", undefined);
    expect(mocks.writeSelection).toHaveBeenCalledWith("/agent", "vercel-cli", {
      teamId: "team_project",
      teamName: "Project team",
    });
  });
  it("returns to chat when key entry is cancelled", async () => {
    const fake = createFakePrompter({
      single: () => "openai",
      password: () => {
        throw new WizardCancelledError();
      },
    });
    expect(await runModelLogin({ appRoot: "/agent", prompter: fake.prompter })).toEqual({
      kind: "cancelled",
    });
    expect(mocks.writeSelection).not.toHaveBeenCalled();
  });
  it("keeps the selected connection intact when secure storage is unavailable", async () => {
    mocks.writeSecret.mockRejectedValue(new Error("Unlock the OS secret store and retry /login."));
    let picks = 0;
    const fake = createFakePrompter({
      single: () => {
        if (picks++) throw new WizardCancelledError();
        return "openai";
      },
      password: () => "key",
    });
    expect(await runModelLogin({ appRoot: "/agent", prompter: fake.prompter })).toEqual({
      kind: "cancelled",
    });
    expect(mocks.writeSelection).not.toHaveBeenCalled();
    expect(mocks.change).not.toHaveBeenCalled();
  });
  it("honors explicit environment credentials in a deterministic order", () => {
    expect(environmentConnection({ OPENAI_API_KEY: "openai" })).toBe("openai");
    expect(environmentConnection({ ANTHROPIC_API_KEY: "anthropic" })).toBe("anthropic");
    expect(environmentConnection({ AI_GATEWAY_API_KEY: "gateway", OPENAI_API_KEY: "openai" })).toBe(
      "ai-gateway-key",
    );
  });
});

afterEach(() => vi.unstubAllEnvs());
