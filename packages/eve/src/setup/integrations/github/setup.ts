import { join } from "node:path";

import { ensureVercelProject } from "#setup/flows/ensure-vercel-project.js";
import { openUrl } from "#setup/primitives/open-url.js";
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
  openUrl: typeof openUrl;
  provisionConnector: typeof provisionGitHubConnector;
  writeTextFile: typeof writeTextFile;
}

const defaultDeps: GitHubSetupDeps = {
  deriveConnectorSlug: deriveSlackConnectorSlug,
  ensureVercelProject,
  openUrl,
  provisionConnector: provisionGitHubConnector,
  writeTextFile,
};

function connectTemplate(uid: string): string {
  return `import { connectGitHubCredentials } from "@vercel/connect/eve";
import { githubChannel } from "eve/channels/github";

export default githubChannel({
  credentials: connectGitHubCredentials(${JSON.stringify(uid)}),
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
    context.ui.prompter.note(
      "Vercel Connect creates a GitHub App and routes verified webhooks to your deployed agent.",
      "GitHub App",
    );
    const project = await deps.ensureVercelProject({
      appRoot: context.appRoot,
      prompter: context.ui.prompter,
      signal: context.signal,
    });
    const connector = await deps.provisionConnector({
      log: context.ui.prompter.log,
      project,
      projectRoot: context.appRoot,
      slug: await deps.deriveConnectorSlug(context.appRoot),
      signal: context.signal,
    });
    await deps.writeTextFile(
      join(context.appRoot, "agent/channels/github.ts"),
      connectTemplate(connector.uid),
      { force: context.force },
    );
    const dashboardUrl = "https://vercel.com/d?to=/%5Bteam%5D/~/connect&title=Open+Vercel+Connect";
    context.ui.nextSteps([
      "Deploy the agent, then open the GitHub App in Vercel Connect and install it in the organization or account where you want to use it.",
      "Mention the app in an issue, pull request, or review comment to start a conversation.",
    ]);
    deps.openUrl(dashboardUrl);
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
