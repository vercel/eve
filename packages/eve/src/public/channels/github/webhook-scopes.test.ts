import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { GITHUB_WEBHOOK_SCOPES } from "#public/channels/github/webhook-scopes.js";

describe("GITHUB_WEBHOOK_SCOPES", () => {
  it("matches the payload schemas of the installed @octokit/openapi-webhooks, so run `node scripts/github-webhook-scopes.mjs` and `npx oxfmt` on its output after upgrading it", async () => {
    const { deriveWebhookScopes } = await import("../../../../scripts/github-webhook-scopes.mjs");
    expect(deriveWebhookScopes()).toEqual(GITHUB_WEBHOOK_SCOPES);
  });

  it("renders the event name types that githubChannel.ts imports, so running the generator keeps them", async () => {
    const { deriveWebhookScopes, renderWebhookScopes } =
      await import("../../../../scripts/github-webhook-scopes.mjs");
    const rendered = renderWebhookScopes(deriveWebhookScopes());
    const types = rendered.slice(rendered.indexOf("type GitHubWebhookScopeName"));
    expect(types).toContain("export type GitHubWebhookEventName");
    expect(readFileSync(new URL("./webhook-scopes.ts", import.meta.url), "utf8")).toContain(types);
  });

  it("scopes an issue or pull request number only to events that have a repository", () => {
    for (const [name, scope] of Object.entries(GITHUB_WEBHOOK_SCOPES))
      if (scope.numbers.length > 0) expect(scope.repo, name).toBe(true);
  });

  it("reads each kind of event from where its payload carries the number", () => {
    expect(GITHUB_WEBHOOK_SCOPES["issues.opened"]).toEqual({ repo: true, numbers: ["issue"] });
    expect(GITHUB_WEBHOOK_SCOPES["pull_request.opened"]).toEqual({
      repo: true,
      numbers: ["pull_request"],
    });
    expect(GITHUB_WEBHOOK_SCOPES["check_suite.completed"]).toEqual({
      repo: true,
      numbers: ["check_suite.pull_requests"],
    });
    expect(GITHUB_WEBHOOK_SCOPES["push"]).toEqual({ repo: true, numbers: [] });
    expect(GITHUB_WEBHOOK_SCOPES["projects_v2.created"]).toEqual({ repo: false, numbers: [] });
  });

  it("offers an optional repository to events whose payload may carry one and none to account-wide events", () => {
    expect(GITHUB_WEBHOOK_SCOPES["merge_group.checks_requested"]).toEqual({
      repo: true,
      numbers: [],
    });
    expect(GITHUB_WEBHOOK_SCOPES["team.added_to_repository"]).toEqual({ repo: true, numbers: [] });
    expect(GITHUB_WEBHOOK_SCOPES["team.removed_from_repository"]).toEqual({
      repo: true,
      numbers: [],
    });
    expect(GITHUB_WEBHOOK_SCOPES["package.published"]).toEqual({ repo: true, numbers: [] });
    expect(GITHUB_WEBHOOK_SCOPES["custom_property.created"]).toEqual({ repo: false, numbers: [] });
  });

  it("leaves out the events the App receives with no account to scope them by", () => {
    const names = Object.keys(GITHUB_WEBHOOK_SCOPES);
    for (const family of [
      "ping",
      "installation",
      "installation_repositories",
      "installation_target",
      "security_advisory",
      "marketplace_purchase",
      "sponsorship",
    ])
      expect(
        names.filter((name) => name.split(".")[0] === family),
        family,
      ).toEqual([]);
  });
});
