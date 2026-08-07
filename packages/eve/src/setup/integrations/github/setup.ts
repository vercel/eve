import { join } from "node:path";

import type { MultiSelectQuestion } from "#setup/ask.js";
import { ensureVercelProject } from "#setup/flows/ensure-vercel-project.js";
import { deriveSlackConnectorSlug } from "#setup/scaffold/index.js";
import { writeTextFile } from "#setup/scaffold/files.js";
import { WizardCancelledError } from "#setup/step.js";

import type {
  IntegrationSetupContext,
  IntegrationSetupResult,
  SetupIntegration,
} from "../types.js";
import { provisionGitHubConnector } from "./connect.js";

export interface GitHubSetupDeps {
  deriveConnectorSlug: typeof deriveSlackConnectorSlug;
  ensureVercelProject: typeof ensureVercelProject;
  provisionConnector: typeof provisionGitHubConnector;
  writeTextFile: typeof writeTextFile;
}

const defaultDeps: GitHubSetupDeps = {
  deriveConnectorSlug: deriveSlackConnectorSlug,
  ensureVercelProject,
  provisionConnector: provisionGitHubConnector,
  writeTextFile,
};

const GITHUB_EVENT_OPTIONS = [
  {
    id: "issue_comment",
    label: "New issue and PR comments",
    value: "issue_comment",
    hint: "Reply when a new timeline comment includes `@<bot-name>`.",
  },
  {
    id: "pull_request_review_comment",
    label: "New inline PR review comments",
    value: "pull_request_review_comment",
    hint: "Reply when a new inline review comment includes `@<bot-name>`.",
  },
  {
    id: "issues",
    label: "New issues",
    value: "issues",
    hint: "Add comments to new issues.",
  },
  {
    id: "pull_request",
    label: "New PRs",
    value: "pull_request",
    hint: "Add comments to new pull requests.",
  },
] as const;

type GitHubWebhookEvent = (typeof GITHUB_EVENT_OPTIONS)[number]["value"];

const DEFAULT_GITHUB_EVENTS: readonly GitHubWebhookEvent[] = [
  "issue_comment",
  "pull_request_review_comment",
];

const githubEventsQuestion: MultiSelectQuestion<GitHubWebhookEvent> = {
  key: "github-events",
  message: "What should this GitHub App respond to?",
  options: GITHUB_EVENT_OPTIONS,
  recommended: DEFAULT_GITHUB_EVENTS,
  requireSelection: true,
};

function connectTemplate(
  uid: string,
  appSlug: string,
  events: readonly GitHubWebhookEvent[],
): string {
  const handlers = [
    events.includes("issues")
      ? `  onIssue(ctx, issue) {
    if (issue.action !== "opened") return null;
    return { auth: defaultGitHubAuth(ctx) };
  },`
      : undefined,
    events.includes("pull_request")
      ? `  onPullRequest(ctx, pullRequest) {
    if (pullRequest.action !== "opened") return null;
    return { auth: defaultGitHubAuth(ctx) };
  },`
      : undefined,
  ].filter((handler): handler is string => handler !== undefined);
  const defaultAuthImport = handlers.length > 0 ? ", defaultGitHubAuth" : "";
  const handlerBlock = handlers.length > 0 ? `\n${handlers.join("\n")}` : "";

  return `import { connectGitHubCredentials } from "@vercel/connect/eve";
import { githubChannel${defaultAuthImport} } from "eve/channels/github";

export default githubChannel({
  botName: ${JSON.stringify(appSlug)},
  credentials: connectGitHubCredentials(${JSON.stringify(uid)}),${handlerBlock}
});
`;
}

/** Runs guided GitHub App connector and channel setup. */
export async function setupGitHub(
  context: IntegrationSetupContext,
  deps: GitHubSetupDeps = defaultDeps,
): Promise<IntegrationSetupResult> {
  if (context.environment.vercel.kind === "unavailable") {
    throw new Error(
      "GitHub setup requires an authenticated Vercel CLI. Run `vercel login`, then retry.",
    );
  }
  try {
    context.ui.prompter.log.info("GitHub App");
    context.ui.prompter.log.info(
      "Vercel Connect creates a GitHub App and routes verified webhooks to your deployed agent.",
    );
    const events = await context.ui.asker.askMany(githubEventsQuestion);
    const project = await deps.ensureVercelProject({
      appRoot: context.appRoot,
      prompter: context.ui.prompter,
      signal: context.signal,
    });
    const connector = await deps.provisionConnector({
      log: context.ui.prompter.log,
      events,
      project,
      projectRoot: context.appRoot,
      slug: await deps.deriveConnectorSlug(context.appRoot),
      signal: context.signal,
    });
    await deps.writeTextFile(
      join(context.appRoot, "agent/channels/github.ts"),
      connectTemplate(connector.uid, connector.appSlug, events),
      { force: context.force },
    );
    const dashboardUrl = "https://vercel.com/d?to=/%5Bteam%5D/~/connect&title=Open+Vercel+Connect";
    context.ui.nextSteps([
      "Deploy the agent, then open the GitHub App in Vercel Connect and install it in the organization or account where you want to use it.",
      `Add @${connector.appSlug} to a new issue, pull request, or review comment to invoke the agent. GitHub may not autocomplete or render the token as a linked mention.`,
    ]);
    return {
      kind: "done",
      completion: {
        facts: [{ label: "Vercel Connect", value: dashboardUrl, kind: "url" }],
      },
    };
  } catch (error) {
    if (error instanceof WizardCancelledError) return { kind: "cancelled" };
    throw error;
  }
}

/** GitHub App setup registration. */
export const GITHUB_SETUP: SetupIntegration = {
  kind: "github",
  label: "GitHub",
  hint: "Respond to issues, pull requests, and comments",
  setup: setupGitHub,
};
