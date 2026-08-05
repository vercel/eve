import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { Asker, Question } from "#setup/ask.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createIntegrationSetupUi } from "../shared/ui.js";
import { setupResend, type ResendSetupDeps } from "./setup.js";

function asker(answers: Record<string, string>): Asker {
  return {
    ask: async <T>(question: Question<T>) => answers[question.key] as T,
    askMany: async () => [],
  };
}

function deps(): ResendSetupDeps {
  return {
    appendEnv: vi.fn(async () => ({ written: [], skipped: [] })),
    createWebhook: vi.fn(async () => ({
      id: "wh_new",
      endpoint: "https://agent.test/eve/v1/resend",
      events: ["email.received"],
      signing_secret: "whsec_secret",
    })),
    deleteWebhook: vi.fn(async () => {}),
    deploy: vi
      .fn()
      .mockResolvedValueOnce({ kind: "deployed", productionUrl: "https://agent.test" })
      .mockResolvedValueOnce({ kind: "deployed", productionUrl: "https://agent.test" }),
    deriveConnectorSlug: vi.fn(async () => "agent" as never),
    ensureVercelProject: vi.fn(async () => ({ orgId: "team", projectId: "project" })),
    listWebhooks: vi.fn(async () => []),
    provisionConnector: vi.fn(async () => ({
      id: "scl_resend",
      uid: "api-key/resend-agent",
    })),
    runVercel: vi.fn(async () => true),
    validateApiKey: vi.fn(async () => {}),
    writeTextFile: vi.fn(async () => {}),
  };
}

function context(effects: ResendSetupDeps, select: "connect" | "portable" = "connect") {
  const fake = createFakePrompter({ single: () => select });
  return {
    effects,
    value: {
      appRoot: "/project",
      environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
      ui: createIntegrationSetupUi({
        asker: asker({
          "resend-api-key": "  re_secret  ",
          "resend-from-address": "agent@example.com",
          "resend-from-name": "Email Agent",
        }),
        prompter: fake.prompter,
      }),
    },
  };
}

describe("Resend setup", () => {
  it("uses one normalized key and orders deploy, webhook, env, and redeploy", async () => {
    const effects = deps();
    const events: string[] = [];
    vi.mocked(effects.validateApiKey).mockImplementation(async (key) => {
      events.push(`validate:${key}`);
    });
    vi.mocked(effects.provisionConnector).mockImplementation(async (input) => {
      events.push(`connector:${input.apiKey}`);
      return { id: "scl_resend", uid: "api-key/resend-agent" };
    });
    vi.mocked(effects.deploy).mockReset();
    vi.mocked(effects.deploy).mockImplementation(async () => {
      events.push("deploy");
      return { kind: "deployed", productionUrl: "https://agent.test" };
    });
    vi.mocked(effects.createWebhook).mockImplementation(async (key) => {
      events.push(`webhook:${key}`);
      return {
        id: "wh_new",
        endpoint: "https://agent.test/eve/v1/resend",
        signing_secret: "whsec_secret",
      };
    });
    vi.mocked(effects.runVercel).mockImplementation(async (_args, options) => {
      events.push(`env:${options.stdin}`);
      return true;
    });

    const setup = context(effects);
    await expect(setupResend(setup.value, effects)).resolves.toMatchObject({ kind: "done" });
    expect(events).toEqual([
      "validate:re_secret",
      "connector:re_secret",
      "deploy",
      "webhook:re_secret",
      "env:whsec_secret",
      "deploy",
    ]);
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/resend.ts",
      expect.stringContaining('getToken("api-key/resend-agent"'),
      { force: undefined },
    );
  });

  it("compensates a newly created webhook when saving the secret fails", async () => {
    const effects = deps();
    vi.mocked(effects.runVercel).mockResolvedValue(false);
    const setup = context(effects);
    await expect(setupResend(setup.value, effects)).rejects.toThrow("may persist");
    expect(effects.deleteWebhook).toHaveBeenCalledWith("re_secret", "wh_new", undefined);
  });

  it("scaffolds portable environment credentials without Vercel effects", async () => {
    const effects = deps();
    const setup = context(effects, "portable");
    await expect(setupResend(setup.value, effects)).resolves.toEqual({ kind: "done" });
    expect(effects.appendEnv).toHaveBeenCalledWith("/project/.env.local", {
      RESEND_API_KEY: "re_secret",
    });
    expect(effects.provisionConnector).not.toHaveBeenCalled();
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/resend.ts",
      expect.stringContaining("process.env.RESEND_API_KEY"),
      { force: undefined },
    );
  });
});
