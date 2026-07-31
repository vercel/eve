import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { SlackConnectorSlug } from "#setup/scaffold/index.js";

import { integrationSetupEnvironment } from "../shared/environment.js";
import { createIntegrationSetupUi } from "../shared/ui.js";
import { setupSlack, type SlackSetupDeps } from "./setup.js";

describe("setupSlack", () => {
  it("uses Vercel Connect without prompting for credentials in non-interactive mode", async () => {
    const fake = createFakePrompter({
      single: () => {
        throw new Error("credential selection must not be prompted");
      },
    });
    const provisionSlackbot = vi.fn(async () => ({
      state: "attached" as const,
      connectorUid: "uid",
    }));
    const effects = {
      deriveSlackConnectorSlug: vi.fn(async () => "agent" as SlackConnectorSlug),
      ensureChannel: vi.fn(async () => ({
        kind: "slack" as const,
        action: "created" as const,
        filesWritten: [],
        filesOverwritten: [],
        filesSkipped: [],
        packageJsonUpdated: [],
        slackConnectorSlug: "agent" as SlackConnectorSlug,
      })),
      ensureVercelProject: vi.fn(async () => ({ orgId: "org-id", projectId: "project-id" })),
      provisionSlackbot,
      reconcileSlackUid: vi.fn(),
    } as SlackSetupDeps;

    await expect(
      setupSlack(
        {
          appRoot: "/project",
          environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
          ui: createIntegrationSetupUi({
            asker: { ask: vi.fn(), askMany: vi.fn() },
            prompter: fake.prompter,
          }),
          yes: true,
        },
        effects,
      ),
    ).resolves.toEqual({ kind: "done" });

    expect(provisionSlackbot).toHaveBeenCalledOnce();
  });
});
