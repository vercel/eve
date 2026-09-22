import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { WizardCancelledError } from "#setup/step.js";
const mocks = vi.hoisted(() => ({
  readSelection: vi.fn(),
  team: vi.fn(),
  readDefault: vi.fn(),
  readSecret: vi.fn(),
  readSession: vi.fn(),
  writeSecret: vi.fn(),
  writeSelection: vi.fn(),
  writeDefault: vi.fn(),
  inspect: vi.fn(),
  change: vi.fn(),
  authored: vi.fn(),
  cli: vi.fn(),
  validate: vi.fn(),
  session: vi.fn(),
  chatgpt: vi.fn(),
  chatgptState: vi.fn(),
  oauth: vi.fn(),
  models: vi.fn(),
  gateway: vi.fn(),
  settingsMatch: vi.fn(),
  catalog: vi.fn(),
}));
vi.mock("#setup/provider-settings.js", () => ({
  providerSettingsMatch: mocks.settingsMatch,
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
  readVercelSession: mocks.readSession,
  writeModelSecret: mocks.writeSecret,
  writeDefaultConnection: mocks.writeDefault,
}));
vi.mock("#services/inspect-application.js", () => ({ inspectApplication: mocks.inspect }));
vi.mock("./model-source-change.js", () => ({
  changeValidatedAgentModel: mocks.change,
  readAuthoredModelSelection: mocks.authored,
}));
vi.mock("#internal/model-auth/vercel-cli.js", () => ({ readVercelCliConnection: mocks.cli }));
vi.mock("#internal/model-auth/vercel.js", () => ({
  authJson: mocks.models,
  resolveVercelSession: mocks.session,
  validateVercelAccess: mocks.validate,
  VERCEL_MODEL_CLIENT_ID: "client-id",
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
  fetchGatewayCatalog: mocks.catalog,
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
  mocks.readSession.mockResolvedValue({ refreshToken: "refresh" });
  mocks.authored.mockResolvedValue("openai/gpt-5.6-luna-fast");
  mocks.oauth.mockResolvedValue({ teamId: "team_123", teamName: "Alice" });
  mocks.catalog.mockResolvedValue([{ id: "openai/gpt-5.6-luna-fast", type: "language" }]);
  mocks.change.mockResolvedValue({ kind: "changed" });
  mocks.readSecret.mockResolvedValue("stored-key");
  mocks.models.mockResolvedValue({
    data: [{ id: "gpt-5.6-luna-fast" }, { id: "claude-sonnet-5" }],
    models: [{ slug: "gpt-5.6-luna-fast" }],
  });
  mocks.gateway.mockResolvedValue({ kind: "valid" });
  mocks.chatgptState.mockResolvedValue({ kind: "ready", reload: true });
});

describe("model login", () => {
  it.each(["vercel", "ai-gateway-key", "chatgpt", "openai", "anthropic"])(
    "connects %s and returns directly to chat",
    async (selected) => {
      const fake = createFakePrompter({ single: () => selected, password: () => "new-key" });
      expect(await runModelLogin({ appRoot: "/agent", prompter: fake.prompter })).toMatchObject({
        kind: "ready",
        reload: ["openai", "anthropic", "chatgpt"].includes(selected),
      });
      expect(fake.selectMessages).toEqual(["Choose a connection"]);
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
    ).toMatchObject({ kind: "ready", reload: false });
    expect(fake.selectMessages).toEqual([]);
    expect(mocks.validate).toHaveBeenCalledWith("cli-token", "team_123", expect.any(AbortSignal));
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
  it("opens login without warning when a saved Vercel session belongs to another client", async () => {
    mocks.readSelection.mockResolvedValue("vercel");
    mocks.readSession.mockResolvedValue(undefined);
    const fake = createFakePrompter({
      single: () => {
        throw new WizardCancelledError();
      },
    });
    expect(
      await runModelLogin({ appRoot: "/agent", prompter: fake.prompter, automatic: true }),
    ).toEqual({ kind: "cancelled" });
    expect(fake.prompter.log.warning).not.toHaveBeenCalled();
    expect(mocks.session).not.toHaveBeenCalled();
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
    ).toMatchObject({ kind: "ready", reload: true });
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
    ).toMatchObject({ kind: "ready", reload: false });
    expect(mocks.validate).toHaveBeenCalledWith(
      "cli-token",
      "team_project",
      expect.any(AbortSignal),
    );
    expect(mocks.writeSelection).toHaveBeenCalledWith(
      "/agent",
      "vercel-cli",
      {
        teamId: "team_project",
        teamName: "Project team",
      },
      undefined,
    );
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

it.each(["openai", "anthropic"] as const)(
  "does not mistake a foreign %s model for an eve helper",
  async (provider) => {
    mocks.authored.mockResolvedValue(undefined);
    mocks.inspect.mockResolvedValue({
      compiledState: {
        manifest: {
          config: {
            model: { id: "custom-model", source: {}, routing: { kind: "external", provider } },
          },
        },
      },
    });
    mocks.change.mockResolvedValue({
      kind: "rejected",
      message: "Model is not an eve helper. Edit agent.ts.",
    });
    let attempts = 0;
    const fake = createFakePrompter({
      single: () => {
        if (attempts++) throw new WizardCancelledError();
        return provider;
      },
      password: () => "new-key",
    });
    await expect(runModelLogin({ appRoot: "/agent", prompter: fake.prompter })).resolves.toEqual({
      kind: "cancelled",
    });
    expect(mocks.change).toHaveBeenCalledOnce();
    expect(mocks.writeSelection).not.toHaveBeenCalled();
    expect(mocks.writeDefault).not.toHaveBeenCalled();
  },
);
it.each(["vercel", "ai-gateway-key"] as const)(
  "connects %s to a source-backed gateway model without rewriting agent.ts",
  async (selected) => {
    mocks.authored.mockResolvedValue(undefined);
    mocks.inspect.mockResolvedValue({
      compiledState: {
        manifest: {
          config: {
            model: {
              id: "anthropic/claude-sonnet-5",
              source: {},
              routing: { kind: "gateway", target: "anthropic" },
            },
          },
        },
      },
    });
    const fake = createFakePrompter({ single: () => selected, password: () => "new-key" });
    await expect(
      runModelLogin({ appRoot: "/agent", prompter: fake.prompter }),
    ).resolves.toMatchObject({ kind: "ready", reload: false });
    expect(fake.selectMessages).toEqual(["Choose a connection"]);
    expect(mocks.change).not.toHaveBeenCalled();
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(mocks.writeSelection.mock.calls[0]?.slice(0, 2)).toEqual(["/agent", selected]);
    expect(mocks.writeDefault).toHaveBeenCalledWith(selected);
    expect(fake.prompter.log.warning).not.toHaveBeenCalled();
  },
);
it.each([
  ["openai", "openai.responses/gpt-5.5"],
  ["anthropic", "anthropic.messages/claude-sonnet-5"],
] as const)(
  "connects %s to a raw SDK instance of the same provider without rewriting agent.ts",
  async (selected, id) => {
    mocks.authored.mockResolvedValue(undefined);
    mocks.inspect.mockResolvedValue({
      compiledState: {
        manifest: {
          config: {
            model: { id, source: {}, routing: { kind: "external", provider: selected } },
          },
        },
      },
    });
    const fake = createFakePrompter({ single: () => selected, password: () => "new-key" });
    await expect(
      runModelLogin({ appRoot: "/agent", prompter: fake.prompter }),
    ).resolves.toMatchObject({ kind: "ready" });
    expect(mocks.change).not.toHaveBeenCalled();
    expect(mocks.writeSecret).toHaveBeenCalledWith(`${selected}-key`, "new-key");
    expect(mocks.writeSelection.mock.calls[0]?.slice(0, 2)).toEqual(["/agent", selected]);
    expect(fake.prompter.log.warning).not.toHaveBeenCalled();
  },
);
it("preserves an explicitly authored eve helper's compatible custom model", async () => {
  mocks.inspect.mockResolvedValue({
    compiledState: {
      manifest: {
        config: {
          model: {
            id: "custom-model",
            source: {},
            routing: { kind: "external", provider: "openai" },
          },
        },
      },
    },
  });
  mocks.authored.mockResolvedValue("openai-api/custom-model");
  const fake = createFakePrompter({ single: () => "openai", password: () => "new-key" });
  await expect(
    runModelLogin({ appRoot: "/agent", prompter: fake.prompter }),
  ).resolves.toMatchObject({
    kind: "ready",
    reload: false,
  });
  expect(mocks.change).not.toHaveBeenCalled();
});

it("reuses CLI validation and source inspection exactly once", async () => {
  mocks.cli.mockResolvedValue({ token: "cli-token", teamId: "team_123" });
  await runModelLogin({
    appRoot: "/agent",
    automatic: true,
    prompter: createFakePrompter().prompter,
  });
  expect(mocks.validate).toHaveBeenCalledOnce();
  expect(mocks.cli).toHaveBeenCalledOnce();
  expect(mocks.authored).toHaveBeenCalledOnce();
  expect(mocks.inspect).not.toHaveBeenCalled();
  expect(mocks.catalog).toHaveBeenCalledOnce();
});

it.each(["openai", "anthropic"] as const)(
  "retains %s models from automatic credential validation",
  async (selected) => {
    mocks.readSelection.mockResolvedValue(selected);
    await runModelLogin({
      appRoot: "/agent",
      automatic: true,
      prompter: createFakePrompter().prompter,
    });
    expect(mocks.models).toHaveBeenCalledOnce();
    expect(mocks.inspect).not.toHaveBeenCalled();
  },
);

it("overlaps Gateway catalog loading with OAuth and does not validate the returned team again", async () => {
  const oauth = Promise.withResolvers<{ teamId: string; teamName: string }>();
  const catalogStarted = Promise.withResolvers<void>();
  mocks.oauth.mockReturnValue(oauth.promise);
  mocks.catalog.mockImplementation(async () => {
    catalogStarted.resolve();
    return [{ id: "openai/gpt-5.6-luna-fast", type: "language" }];
  });
  const result = runModelLogin({
    appRoot: "/agent",
    prompter: createFakePrompter({ single: () => "vercel" }).prompter,
  });
  await catalogStarted.promise;
  expect(mocks.oauth).toHaveBeenCalledOnce();
  expect(mocks.writeSelection).not.toHaveBeenCalled();
  oauth.resolve({ teamId: "team_selected", teamName: "Selected" });
  await result;
  expect(mocks.writeSelection).toHaveBeenCalledWith(
    "/agent",
    "vercel",
    { teamId: "team_selected", teamName: "Selected" },
    undefined,
  );
  expect(mocks.session).not.toHaveBeenCalled();
  expect(mocks.validate).not.toHaveBeenCalled();
});

it("leaves an unchanged connection alone", async () => {
  mocks.readSelection.mockResolvedValue("vercel-cli");
  mocks.settingsMatch.mockResolvedValue(true);
  mocks.cli.mockResolvedValue({ token: "cli-token", teamId: "team_123" });
  const withConnectionUpdate = vi.fn();
  await expect(
    runModelLogin({
      appRoot: "/agent",
      automatic: true,
      prompter: createFakePrompter().prompter,
      withConnectionUpdate,
    }),
  ).resolves.toMatchObject({ kind: "ready", reload: false });
  expect(mocks.change).not.toHaveBeenCalled();
  expect(mocks.writeSelection).not.toHaveBeenCalled();
  expect(withConnectionUpdate).not.toHaveBeenCalled();
});

it("waits for a single runtime activation before reporting a changed connection ready", async () => {
  const activation = Promise.withResolvers<void>();
  const written = Promise.withResolvers<void>();
  const withConnectionUpdate = vi.fn(async (task: () => Promise<void>): Promise<void> => {
    await task();
    written.resolve();
    await activation.promise;
  });
  let ready = false;
  const result = runModelLogin({
    appRoot: "/agent",
    prompter: createFakePrompter({ single: () => "openai", password: () => "key" }).prompter,
    withConnectionUpdate,
  }).then((value) => {
    ready = true;
    return value;
  });
  await written.promise;
  expect(ready).toBe(false);
  expect(mocks.change).toHaveBeenCalledOnce();
  expect(mocks.writeSelection).toHaveBeenCalledOnce();
  activation.resolve();
  expect(await result).toMatchObject({ kind: "ready", reload: false });
  expect(withConnectionUpdate).toHaveBeenCalledOnce();
});

it("does not save a connection when an overlapping catalog request fails", async () => {
  mocks.catalog.mockRejectedValue(new Error("Gateway is unavailable."));
  let picks = 0;
  const prompter = createFakePrompter({
    single: () => {
      if (picks++) throw new WizardCancelledError();
      return "vercel";
    },
  }).prompter;
  expect(await runModelLogin({ appRoot: "/agent", prompter })).toEqual({ kind: "cancelled" });
  expect(mocks.writeSelection).not.toHaveBeenCalled();
  expect(mocks.writeDefault).not.toHaveBeenCalled();
});

it("changes teams without recompiling an unchanged Gateway model", async () => {
  const withConnectionUpdate = vi.fn();
  mocks.settingsMatch.mockResolvedValue(false);
  const result = await runModelLogin({
    appRoot: "/agent",
    withConnectionUpdate,
    prompter: createFakePrompter({ single: () => "vercel" }).prompter,
  });
  expect(result).toMatchObject({
    kind: "ready",
    reload: false,
    model: {
      id: "openai/gpt-5.6-luna-fast",
      endpoint: { kind: "gateway", connected: true, credential: "oauth", team: "Alice" },
    },
  });
  expect(mocks.writeSelection).toHaveBeenCalledOnce();
  expect(mocks.change).not.toHaveBeenCalled();
  expect(withConnectionUpdate).not.toHaveBeenCalled();
});
