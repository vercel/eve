import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
const mocks = vi.hoisted(() => ({ secrets: new Map<string, string>(), defaults: vi.fn() }));
vi.mock("#internal/model-auth/store.js", async (original) => ({
  ...(await original<typeof import("#internal/model-auth/store.js")>()),
  readModelSecret: async (name: string) => mocks.secrets.get(name),
  writeModelSecret: async (name: string, key: string) => {
    mocks.secrets.set(name, key);
  },
  writeDefaultConnection: mocks.defaults,
}));
vi.mock("#services/inspect-application.js", () => ({
  inspectApplication: async () => ({
    compiledState: {
      manifest: {
        config: { model: { id: "openai/gpt-5.6-luna-fast", routing: { kind: "gateway" } } },
      },
    },
  }),
}));
vi.mock("./model-source-change.js", () => ({
  readAuthoredModelSelection: async () => "openai/gpt-5.6-luna-fast",
  changeValidatedAgentModel: async () => ({ kind: "changed" }),
}));
vi.mock("#internal/model-auth/available-models.js", () => ({
  availableDirectModels: async () => ["gpt-5.6-luna-fast", "claude-sonnet-5"],
  availableHelperModels: async () => ["gpt-5.6-luna-fast", "claude-sonnet-5"],
}));
vi.mock("#internal/model-auth/vercel.js", () => ({
  resolveVercelSession: async () => ({
    accessToken: "account-secret",
    teamId: "team_alice",
    teamName: "Alice",
  }),
  validateVercelAccess: async () => {},
}));
vi.mock("./vercel-model-login.js", () => ({
  loginVercelModel: async () => ({ teamId: "team_alice", teamName: "Alice" }),
}));
vi.mock("./chatgpt-auth.js", () => ({ ensureChatGptAuth: async () => {} }));
vi.mock("../boxes/select-model.js", () => ({
  fetchGatewayCatalog: async () => [{ id: "openai/gpt-5.6-luna-fast", type: "language" }],
}));
vi.mock("#setup/validate-gateway-key.js", () => ({
  validateGatewayApiKey: async () => ({ kind: "valid" }),
}));
import { runModelLogin } from "./model-login.js";
import { readProviderSelection, readProviderTeamSync } from "#setup/provider-settings.js";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  mocks.secrets.clear();
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("switches all five connections while keeping keys out of project files", async () => {
  vi.stubEnv("EVE_DEV", "1");
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AI_GATEWAY_API_KEY"])
    vi.stubEnv(key, "");
  const root = await mkdtemp(join(tmpdir(), "eve-model-login-"));
  roots.push(root);
  await writeFile(join(root, ".env.local"), "USER_SETTING=preserved\n");
  for (const selected of ["chatgpt", "vercel", "ai-gateway-key", "openai", "anthropic"]) {
    const fake = createFakePrompter({ single: () => selected, password: () => "entered-secret" });
    expect(await runModelLogin({ appRoot: root, prompter: fake.prompter })).toMatchObject({
      kind: "ready",
      reload: ["chatgpt", "openai", "anthropic"].includes(selected),
    });
    expect(await readProviderSelection(root)).toBe(selected);
    expect(mocks.defaults).toHaveBeenLastCalledWith(selected);
    const metadata = await readFile(join(root, ".eve/provider.json"), "utf8");
    expect(metadata).not.toContain("entered-secret");
    expect(metadata).not.toContain("account-secret");
    if (selected === "vercel") expect(readProviderTeamSync(root)?.teamId).toBe("team_alice");
    else expect(readProviderTeamSync(root)).toBeUndefined();
    expect(await readFile(join(root, ".env.local"), "utf8")).toBe("USER_SETTING=preserved\n");
  }
  expect(mocks.secrets.size).toBe(3);
});
