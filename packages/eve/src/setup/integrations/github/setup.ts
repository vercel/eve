import { join } from "node:path";

import type { MultiSelectQuestion } from "#setup/ask.js";
import { readProjectLink, type VercelProjectReference } from "#setup/project-resolution.js";
import { deriveSlackConnectorSlug } from "#setup/scaffold/index.js";
import { writeTextFile } from "#setup/scaffold/files.js";

import { resolveIntegrationVercelProject } from "../shared/vercel-project.js";
import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";
import { provisionGitHubConnector } from "./connect.js";

export interface GitHubSetupDeps {
  deriveConnectorSlug: typeof deriveSlackConnectorSlug;
  readProjectLink: typeof readProjectLink;
  provisionConnector: typeof provisionGitHubConnector;
  writeTextFile: typeof writeTextFile;
}

const defaultDeps: GitHubSetupDeps = {
  deriveConnectorSlug: deriveSlackConnectorSlug,
  readProjectLink,
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

const githubEventsQuestion: MultiSelectQuestion<GitHubWebhookEvent> = {
  key: "github-events",
  message: "What should this GitHub App respond to?",
  options: GITHUB_EVENT_OPTIONS,
  recommended: ["issue_comment", "pull_request_review_comment"],
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
      ? `  onIssue(ctx, issue) {\n    if (issue.action !== "opened") return null;\n    return { auth: defaultGitHubAuth(ctx) };\n  },`
      : undefined,
    events.includes("pull_request")
      ? `  onPullRequest(ctx, pullRequest) {\n    if (pullRequest.action !== "opened") return null;\n    return { auth: defaultGitHubAuth(ctx) };\n  },`
      : undefined,
  ].filter((handler): handler is string => handler !== undefined);
  const defaultAuthImport = handlers.length > 0 ? ", defaultGitHubAuth" : "";
  const handlerBlock = handlers.length > 0 ? `\n${handlers.join("\n")}` : "";
  return `import { connectGitHubCredentials } from "@vercel/connect/eve";\nimport { githubChannel${defaultAuthImport} } from "eve/channels/github";\n\nexport default githubChannel({\n  botName: ${JSON.stringify(appSlug)},\n  credentials: connectGitHubCredentials(${JSON.stringify(uid)}),${handlerBlock}\n});\n`;
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
  if (context.environment.vercel.kind === "unavailable") {
    throw new Error(
      "GitHub setup requires an authenticated Vercel CLI. Run `vercel login`, then retry.",
    );
  }
  const events = await context.asker.askMany(githubEventsQuestion);
  const project = await resolveIntegrationVercelProject({
    appRoot: context.appRoot,
    integration: "GitHub",
    signal: context.signal,
    deps,
  });
  return { events, project, slug: await deps.deriveConnectorSlug(context.appRoot) };
}

export async function applyGitHubSetup(
  plan: GitHubSetupPlan,
  context: SetupApplyContext,
  deps: GitHubSetupDeps = defaultDeps,
) {
  context.presentation.log.info("GitHub App");
  context.presentation.log.info(
    "Vercel Connect creates a GitHub App and routes verified webhooks to your deployed agent.",
  );
  const connector = await deps.provisionConnector({
    log: context.presentation.log,
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
  const dashboardUrl = "https://vercel.com/d?to=/%5Bteam%5D/~/connect&title=Open+Vercel+Connect";
  context.presentation.nextSteps([
    "Deploy the agent, then open the GitHub App in Vercel Connect and install it in the organization or account where you want to use it.",
    `Add @${connector.appSlug} to a new issue, pull request, or review comment to invoke the agent. GitHub may not autocomplete or render the token as a linked mention.`,
  ]);
  return {
    facts: [{ label: "Vercel Connect", value: dashboardUrl, kind: "url" as const }],
    deploymentRequired: true as const,
  };
}

export const GITHUB_SETUP = defineSetupIntegration({
  kind: "github",
  label: "GitHub",
  hint: "Respond to issues, pull requests, and comments",
  prepare: prepareGitHubSetup,
  apply: applyGitHubSetup,
});
