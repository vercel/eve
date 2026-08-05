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
    listMarketplaceResources: vi.fn(async () => []),
    listDomains: vi.fn(async () => ["example.com"]),
    openUrl: vi.fn(),
    provisionMarketplaceResource: vi.fn(async (input) => ({
      id: "store_resend",
      externalResourceId: input.domain,
      name: "resend-agent",
      product: { slug: "resend-email", integrationConfigurationId: "icfg_resend" },
      projectsMetadata: [{ projectId: "project", environments: ["production"] }],
    })),
    connectMarketplaceResource: vi.fn(async () => {}),
    authorizeMarketplaceSetup: vi.fn(async () => ({
      accessToken: "oauth_marketplace",
      connectorUid: "oauth/eve-resend-setup",
      cleanup: vi.fn(async () => {}),
    })),
    createApiKey: vi.fn(async () => ({ id: "key_resend", token: "re_generated" })),
    deleteApiKey: vi.fn(async () => {}),
    reconcileMarketplaceWebhook: vi.fn(async () => ({
      id: "wh_marketplace",
      signingSecret: "whsec_marketplace",
      previousIds: [],
    })),
    deleteMarketplaceWebhooks: vi.fn(async () => {}),
    waitForMarketplaceDomain: vi.fn(async (input) => input.resource),
    runVercel: vi.fn(async () => true),
    suggestFromAddress: vi.fn(async () => "eve@example.com"),
    validateApiKey: vi.fn(async () => {}),
    writeTextFile: vi.fn(async () => {}),
  };
}

function context(
  effects: ResendSetupDeps,
  select: "marketplace" | "connect" | "portable" = "connect",
) {
  const fake = createFakePrompter({
    single: (options) =>
      options.message === "How would you like to configure Resend?"
        ? select
        : (options.initialValue ?? options.options[0]!.value),
  });
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
  it("provisions a Marketplace resource from an existing Vercel domain", async () => {
    const effects = deps();
    const setup = context(effects, "marketplace");

    await expect(setupResend(setup.value, effects)).resolves.toMatchObject({ kind: "done" });
    expect(effects.provisionMarketplaceResource).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "example.com" }),
    );
    expect(effects.connectMarketplaceResource).toHaveBeenCalledWith(
      expect.objectContaining({ resource: expect.objectContaining({ id: "store_resend" }) }),
    );
    expect(effects.waitForMarketplaceDomain).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "example.com" }),
    );
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/resend.ts",
      expect.stringContaining("process.env.RESEND_API_KEY"),
      { force: undefined },
    );
    expect(effects.authorizeMarketplaceSetup).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "team" }),
    );
    expect(effects.reconcileMarketplaceWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "oauth_marketplace",
        endpoint: "https://agent.test/eve/v1/resend",
      }),
    );
    expect(effects.runVercel).toHaveBeenCalledWith(
      ["env", "add", "RESEND_WEBHOOK_SECRET", "production", "--force", "--yes"],
      expect.objectContaining({ stdin: "whsec_marketplace" }),
    );
  });

  it("reuses an existing Marketplace resource", async () => {
    const effects = deps();
    vi.mocked(effects.listMarketplaceResources).mockResolvedValue([
      {
        id: "store_existing",
        externalResourceId: "mail.example.com",
        name: "resend-existing",
        product: { slug: "resend-email", integrationConfigurationId: "icfg_existing" },
        projectsMetadata: [{ projectId: "project", environments: ["production"] }],
      },
    ]);
    const setup = context(effects, "marketplace");

    await expect(setupResend(setup.value, effects)).resolves.toMatchObject({ kind: "done" });
    expect(effects.provisionMarketplaceResource).not.toHaveBeenCalled();
    expect(effects.connectMarketplaceResource).toHaveBeenCalledWith(
      expect.objectContaining({ resource: expect.objectContaining({ id: "store_existing" }) }),
    );
  });

  it("offers a searchable domain picker and Vercel web handoff", async () => {
    const effects = deps();
    vi.mocked(effects.listDomains).mockResolvedValue([
      "alpha.example",
      "beta.example",
      "gamma.example",
      "delta.example",
      "epsilon.example",
      "zeta.example",
    ]);
    let domainPicker: unknown;
    const fake = createFakePrompter({
      single: (options) => {
        if (options.message === "How would you like to configure Resend?") return "marketplace";
        domainPicker = options;
        return "__add-vercel-domain__";
      },
    });
    const setup = context(effects, "marketplace");
    const value = {
      ...setup.value,
      ui: createIntegrationSetupUi({ asker: setup.value.ui.asker, prompter: fake.prompter }),
    };

    await expect(setupResend(value, effects)).resolves.toEqual({ kind: "cancelled" });
    expect(domainPicker).toEqual(
      expect.objectContaining({
        message: "Domain for Resend",
        search: true,
        placeholder: "type to filter domains",
        options: [
          expect.objectContaining({
            value: "__add-vercel-domain__",
            featured: true,
            trailingAction: true,
          }),
          expect.objectContaining({ value: "alpha.example", featured: true }),
          expect.objectContaining({ value: "beta.example", featured: true }),
          expect.objectContaining({ value: "gamma.example", featured: true }),
          expect.objectContaining({ value: "delta.example", featured: true }),
          expect.objectContaining({ value: "epsilon.example", featured: false }),
          expect.objectContaining({ value: "zeta.example", featured: false }),
        ],
      }),
    );
    expect(effects.openUrl).toHaveBeenCalledWith("https://vercel.com/domains");
  });

  it("hands domain setup off to Vercel web when the team has no domain", async () => {
    const effects = deps();
    vi.mocked(effects.listDomains).mockResolvedValue([]);
    const setup = context(effects, "marketplace");

    await expect(setupResend(setup.value, effects)).resolves.toEqual({ kind: "cancelled" });
    expect(effects.openUrl).toHaveBeenCalledWith("https://vercel.com/domains");
    expect(setup.value.ui.prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("rerun `eve add channel/resend`"),
      "Vercel domain required",
      { tone: "warning" },
    );
    expect(effects.provisionMarketplaceResource).not.toHaveBeenCalled();
  });

  it("defaults the optional sender name to Eve", async () => {
    const effects = deps();
    const questions: Question<unknown>[] = [];
    const setup = context(effects, "portable");
    const value = {
      ...setup.value,
      ui: {
        ...setup.value.ui,
        asker: {
          ask: async <T>(question: Question<T>) => {
            questions.push(question as Question<unknown>);
            if (question.key === "resend-api-key") return "re_secret" as T;
            if (question.key === "resend-from-address") return "eve@example.com" as T;
            return question.detected as T;
          },
          askMany: async () => [],
        },
      },
    };

    await expect(setupResend(value, effects)).resolves.toEqual({ kind: "done" });
    expect(questions).toContainEqual(
      expect.objectContaining({ key: "resend-from-name", detected: "Eve" }),
    );
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/resend.ts",
      expect.stringContaining('fromName: "Eve"'),
      { force: undefined },
    );
  });

  it("prefills the agent address from a send-and-receive custom Resend domain", async () => {
    const effects = deps();
    const questions: Question<unknown>[] = [];
    const setup = context(effects, "portable");
    const value = {
      ...setup.value,
      ui: {
        ...setup.value.ui,
        asker: {
          ask: async <T>(question: Question<T>) => {
            questions.push(question as Question<unknown>);
            if (question.key === "resend-api-key") return "re_secret" as T;
            if (question.key === "resend-from-name") return "Email Agent" as T;
            return question.detected as T;
          },
          askMany: async () => [],
        },
      },
    };

    await expect(setupResend(value, effects)).resolves.toEqual({ kind: "done" });
    expect(effects.suggestFromAddress).toHaveBeenCalledWith("re_secret", undefined);
    expect(questions).toContainEqual(
      expect.objectContaining({
        key: "resend-from-address",
        detected: "eve@example.com",
      }),
    );
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/resend.ts",
      expect.stringContaining('fromAddress: "eve@example.com"'),
      { force: undefined },
    );
  });

  it("warns when the account has no custom domain that can send and receive", async () => {
    const effects = deps();
    vi.mocked(effects.suggestFromAddress).mockResolvedValue(undefined);
    const setup = context(effects, "portable");
    const questions: Question<unknown>[] = [];
    const value = {
      ...setup.value,
      ui: {
        ...setup.value.ui,
        asker: {
          ask: async <T>(question: Question<T>) => {
            questions.push(question as Question<unknown>);
            if (question.key === "resend-api-key") return "re_secret" as T;
            if (question.key === "resend-from-name") return "Email Agent" as T;
            return question.detected as T;
          },
          askMany: async () => [],
        },
      },
    };

    await expect(setupResend(value, effects)).resolves.toEqual({ kind: "done" });
    expect(setup.value.ui.prompter.note).toHaveBeenCalledWith(
      expect.stringMatching(
        /\*\.resend\.app domain receives email but cannot send replies[\s\S]*onboarding@resend\.dev is prefilled/,
      ),
      "Warning: No custom Resend sending domain found",
      { tone: "warning" },
    );
    expect(questions).toContainEqual(
      expect.objectContaining({
        key: "resend-from-address",
        detected: "onboarding@resend.dev",
      }),
    );
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/resend.ts",
      expect.stringContaining('fromAddress: "onboarding@resend.dev"'),
      { force: undefined },
    );
  });

  it("uses existing-account OAuth to create the runtime API key without prompting", async () => {
    const effects = deps();
    const questions: Question<unknown>[] = [];
    const setup = context(effects, "connect");
    const value = {
      ...setup.value,
      ui: {
        ...setup.value.ui,
        asker: {
          ask: async <T>(question: Question<T>) => {
            questions.push(question as Question<unknown>);
            if (question.key === "resend-from-name") return "Eve" as T;
            return question.detected as T;
          },
          askMany: async () => [],
        },
      },
    };

    await expect(setupResend(value, effects)).resolves.toMatchObject({ kind: "done" });
    expect(questions.map((question) => question.key)).not.toContain("resend-api-key");
    expect(effects.createApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "oauth_marketplace" }),
    );
    expect(effects.validateApiKey).toHaveBeenCalledWith("re_generated", undefined);
    expect(effects.runVercel).toHaveBeenCalledWith(
      ["env", "add", "RESEND_API_KEY", "production", "--force", "--yes"],
      expect.objectContaining({ stdin: "re_generated" }),
    );
  });

  it("uses one normalized key and orders deploy, webhook, env, and redeploy", async () => {
    const effects = deps();
    const events: string[] = [];
    vi.mocked(effects.validateApiKey).mockImplementation(async (key) => {
      events.push(`validate:${key}`);
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

    vi.mocked(effects.createApiKey).mockResolvedValue({ id: "key_resend", token: "re_secret" });
    const setup = context(effects);
    await expect(setupResend(setup.value, effects)).resolves.toMatchObject({ kind: "done" });
    expect(events).toEqual([
      "validate:re_secret",
      "env:re_secret",
      "deploy",
      "webhook:re_secret",
      "env:whsec_secret",
      "deploy",
    ]);
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/resend.ts",
      expect.stringContaining("process.env.RESEND_API_KEY"),
      { force: undefined },
    );
  });

  it("compensates a newly created webhook when saving the secret fails", async () => {
    const effects = deps();
    vi.mocked(effects.runVercel).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    vi.mocked(effects.createApiKey).mockResolvedValue({ id: "key_resend", token: "re_secret" });
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
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/resend.ts",
      expect.stringContaining("process.env.RESEND_API_KEY"),
      { force: undefined },
    );
  });
});
