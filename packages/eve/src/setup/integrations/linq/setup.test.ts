import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, withAnswers, withPolicy } from "#setup/ask.js";

vi.mock("#setup/scaffold/index.js", () => ({
  deriveSlackConnectorSlug: vi.fn(async () => "agent"),
}));

import { prepareLinqSetup, type LinqSetupDeps } from "./setup.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";

function deps(): LinqSetupDeps {
  return { listPhoneNumbers: vi.fn(async () => ["+14155550123", "+14155550124"]) };
}

function contexts(answers: Record<string, unknown> = {}) {
  return createSetupContexts({
    appRoot: "/project",
    asker: withAnswers(answers)(withPolicy("assume")(headlessAsker())),
    environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
    prompter: createFakePrompter().prompter,
    resolveVercelProject: vi.fn(async () => ({ orgId: "team", projectId: "project" })),
  });
}

describe("Linq setup", () => {
  it("prepares a managed Linq account by default", async () => {
    await expect(prepareLinqSetup(contexts().prepare)).resolves.toMatchObject({
      credentials: "connect",
      connectorSlug: "agent",
      project: { orgId: "team", projectId: "project" },
    });
  });

  it("fetches an existing Linq account's agent phone numbers", async () => {
    const context = contexts({
      "linq-account": "existing",
      "linq-existing-api-token": "linq-token",
      "linq-existing-phone-numbers": ["+14155550124"],
    });
    const setupDeps = deps();

    await expect(prepareLinqSetup(context.prepare, setupDeps)).resolves.toMatchObject({
      existingAccount: {
        apiToken: "linq-token",
        phoneNumbers: ["+14155550124"],
      },
    });
    expect(setupDeps.listPhoneNumbers).toHaveBeenCalledWith("linq-token", undefined);
  });
});
