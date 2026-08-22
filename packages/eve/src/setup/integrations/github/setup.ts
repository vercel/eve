import { join } from "node:path";

import type { MultiSelectQuestion } from "#setup/ask.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import { deriveSlackConnectorSlug } from "#setup/scaffold/index.js";
import { writeTextFile } from "#setup/scaffold/files.js";

import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";
import { provisionGitHubConnector } from "./connect.js";

export interface GitHubSetupDeps {
  deriveConnectorSlug: typeof deriveSlackConnectorSlug;
  provisionConnector: typeof provisionGitHubConnector;
  writeTextFile: typeof writeTextFile;
}

const defaultDeps: GitHubSetupDeps = {
  deriveConnectorSlug: deriveSlackConnectorSlug,
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
  { id: "issues", label: "New issues", value: "issues", hint: "Add comments to new issues." },
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
  required: true,
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

export interface GitHubSetupPlan {
  events: readonly GitHubWebhookEvent[];
  project: VercelProjectReference;
  slug: string;
}

export async function prepareGitHubSetup(
  context: SetupPrepareContext,
  deps: GitHubSetupDeps = defaultDeps,
): Promise<GitHubSetupPlan> {
  const events = await context.asker.askMany(githubEventsQuestion);
  const project = await context.resolveVercelProject("GitHub");
  return { events, project, slug: await deps.deriveConnectorSlug(context.appRoot) };
}

export async function applyGitHubSetup(
  plan: GitHubSetupPlan,
  context: SetupApplyContext,
  deps: GitHubSetupDeps = defaultDeps,
) {
  context.presenter.log.info("GitHub App");
  context.presenter.log.info(
    "Vercel Connect creates a GitHub App and routes verified webhooks to your deployed agent.",
  );
  const connector = await deps.provisionConnector({
    log: context.presenter.log,
    events: plan.events,
    project: plan.project,
    projectRoot: context.appRoot,
    slug: plan.slug,
    signal: context.signal,
  });
  await deps.writeTextFile(
    join(context.appRoot, "agent/channels/github.ts"),
    connectTemplate(connector.uid, connector.appSlug, plan.events),
    { force: context.force },
  );
  context.presenter.nextSteps([
    "Deploy the agent, then open the GitHub App in Vercel Connect and install it in the organization or account where you want to use it.",
    `Add @${connector.appSlug} to a new issue, pull request, or review comment to invoke the agent. GitHub may not autocomplete or render the token as a linked mention.`,
  ]);
  return { facts: [], deploymentRequired: true as const };
}

export const GITHUB_SETUP = defineSetupIntegration({
  kind: "github",
  label: "GitHub",
  hint: "Respond to issues, pull requests, and comments",
  prepare: prepareGitHubSetup,
  apply: applyGitHubSetup,
});
