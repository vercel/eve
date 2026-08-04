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
    label: "New issue and pull request comments",
    value: "issue_comment",
    hint: "Start a turn when a new timeline comment @mentions the app.",
  },
  {
    id: "pull_request_review_comment",
    label: "New inline pull request review comments",
    value: "pull_request_review_comment",
    hint: "Start a turn when a new inline review comment @mentions the app.",
  },
  {
    id: "issues",
    label: "New issues",
    value: "issues",
    hint: "Start a turn when an issue is opened. Other issue changes are ignored.",
  },
  {
    id: "pull_request",
    label: "New pull requests",
    value: "pull_request",
    hint: "Start a turn when a pull request is opened. Other pull request changes are ignored.",
  },
  {
    id: "check_suite",
    label: "Completed check suites",
    value: "check_suite",
    hint: "Start a turn when a check suite completes for a pull request, including successful and failed suites.",
  },
  {
    id: "check_run",
    label: "Completed check runs",
    value: "check_run",
    hint: "Start a turn when a check run completes for a pull request, including successful and failed runs.",
  },
  {
    id: "workflow_run",
    label: "Completed GitHub Actions workflow runs",
    value: "workflow_run",
    hint: "Start a turn when a GitHub Actions workflow run completes for a pull request, including successful and failed runs.",
  },
] as const;

type GitHubWebhookEvent = (typeof GITHUB_EVENT_OPTIONS)[number]["value"];

const DEFAULT_GITHUB_EVENTS: readonly GitHubWebhookEvent[] = [
  "issue_comment",
  "pull_request_review_comment",
];

const githubEventsQuestion: MultiSelectQuestion<GitHubWebhookEvent> = {
  key: "github-events",
  message:
    "Which GitHub webhook events should this app subscribe to? The generated channel starts turns only for the conditions described below.",
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
    events.includes("check_suite")
      ? `  onCheckSuite(ctx, checkSuite) {
    if (checkSuite.action !== "completed") return null;
    return { auth: defaultGitHubAuth(ctx) };
  },`
      : undefined,
    events.includes("check_run")
      ? `  onCheckRun(ctx, checkRun) {
    if (checkRun.action !== "completed") return null;
    return { auth: defaultGitHubAuth(ctx) };
  },`
      : undefined,
    events.includes("workflow_run")
      ? `  onWorkflowRun(ctx, workflowRun) {
    if (workflowRun.action !== "completed") return null;
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
      `Mention @${connector.appSlug} in an issue, pull request, or review comment to start a conversation.`,
    ]);
    return {
      kind: "done",
      facts: [{ label: "Vercel Connect", value: dashboardUrl, kind: "url" }],
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
