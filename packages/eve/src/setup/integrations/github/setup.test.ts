import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { Asker } from "#setup/ask.js";

import { integrationSetupEnvironment } from "../shared/environment.js";
import { createIntegrationSetupUi } from "../shared/ui.js";
import { setupGitHub, type GitHubSetupDeps } from "./setup.js";

function deps(): GitHubSetupDeps {
  return {
    deriveConnectorSlug: vi.fn(async () => "agent" as never),
    ensureVercelProject: vi.fn(async () => ({ orgId: "team-id", projectId: "project-id" })),
    provisionConnector: vi.fn(async () => ({
      appSlug: "agent",
      id: "scl_github",
      uid: "github/agent",
    })),
    writeTextFile: vi.fn(async () => {}),
  };
}

describe("GitHub setup", () => {
  function asker(events = ["issue_comment", "pull_request_review_comment"]): Asker {
    return {
      ask: vi.fn(),
      askMany: vi.fn(async () => events) as Asker["askMany"],
    };
  }

  it("provisions Connect, routes the selected webhooks, and scaffolds matching handlers", async () => {
    const fake = createFakePrompter();
    const effects = deps();
    const selectedEvents = ["issue_comment", "issues", "pull_request"];

    await expect(
      setupGitHub(
        {
          appRoot: "/project",
          environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
          ui: createIntegrationSetupUi({ asker: asker(selectedEvents), prompter: fake.prompter }),
        },
        effects,
      ),
    ).resolves.toMatchObject({ kind: "done", completion: { deploymentRequired: true } });

    expect(effects.provisionConnector).toHaveBeenCalledWith(
      expect.objectContaining({ events: selectedEvents }),
    );
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/github.ts",
      expect.stringContaining('connectGitHubCredentials("github/agent")'),
      { force: undefined },
    );
    const scaffold = vi.mocked(effects.writeTextFile).mock.calls[0]?.[1] ?? "";
    expect(scaffold).toContain('botName: "agent"');
    expect(scaffold).toContain("onIssue(ctx, issue)");
    expect(scaffold).toContain("onPullRequest(ctx, pullRequest)");
  });

  it("recommends comment events that the default scaffold handles", async () => {
    const fake = createFakePrompter();
    const askMany = vi.fn(async () => [
      "issue_comment",
      "pull_request_review_comment",
    ]) as Asker["askMany"];

    await setupGitHub(
      {
        appRoot: "/project",
        environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
        ui: createIntegrationSetupUi({
          asker: { ask: vi.fn(), askMany },
          prompter: fake.prompter,
        }),
      },
      deps(),
    );

    expect(askMany).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "github-events",
        recommended: ["issue_comment", "pull_request_review_comment"],
      }),
    );
  });

  it("requires an authenticated Vercel CLI", async () => {
    const fake = createFakePrompter();
    await expect(
      setupGitHub({
        appRoot: "/project",
        environment: integrationSetupEnvironment("logged-out", { kind: "unresolved" }),
        ui: createIntegrationSetupUi({
          asker: asker(),
          prompter: fake.prompter,
        }),
      }),
    ).rejects.toThrow("vercel login");
  });
});
