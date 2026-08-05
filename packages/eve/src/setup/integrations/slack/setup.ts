import {
  deriveSlackConnectorSlug,
  ensureChannel,
  type SlackConnectorSlug,
} from "#setup/scaffold/index.js";
import { ensureVercelProject } from "#setup/flows/ensure-vercel-project.js";
import {
  provisionSlackbot,
  reconcileSlackUid,
  type ProvisionSlackbotOptions,
  type ProvisionSlackbotResult,
} from "#setup/slackbot.js";
import { WizardCancelledError } from "#setup/step.js";
import { slackMessageDeepLink } from "#setup/slack-connect.js";

import { installScaffoldDependencies, reportOverwrittenFiles } from "../shared/scaffold.js";
import type {
  IntegrationSetupContext,
  IntegrationSetupResult,
  SetupIntegration,
} from "../types.js";

const SLACK_REQUIRES_VERCEL = "Slack setup with Vercel Connect requires a linked Vercel project.";

type SlackbotFailure = Exclude<
  ProvisionSlackbotResult,
  { state: "attached" } | { state: "cancelled" }
>;

function slackbotFailureCopy(result: SlackbotFailure): { reason: string; followUp: string } {
  switch (result.state) {
    case "not-installed":
      return {
        reason: "Slackbot is not connected to a Slack workspace. Slack channel was not added.",
        followUp: "Re-run `eve add channel/slack` after the workspace install is complete.",
      };
    case "cleanup-failed":
      return {
        reason: "The abandoned Slack connector could not be removed. Slack channel was not added.",
        followUp: "Resolve the cleanup warning above before trying again.",
      };
    case "connector-lookup-failed":
      return {
        reason: "Existing Slack connectors could not be inspected. Slack channel was not added.",
        followUp: "Restore Vercel CLI access, then re-run `eve add channel/slack`.",
      };
    case "installation-check-failed":
      return {
        reason: "Slack workspace installation could not be verified. Slack channel was not added.",
        followUp: "Verify Vercel Connect is reachable, then re-run `eve add channel/slack`.",
      };
    case "existing-not-installed":
      return {
        reason:
          "The existing Slack connector is not connected to a Slack workspace. Slack channel was not added.",
        followUp: "Resolve the existing connector warning above before trying again.",
      };
    case "detach-failed":
      return {
        reason:
          "Slackbot provisioning could not replace the existing trigger destination. Slack channel was not added.",
        followUp: "Run the `vercel connect detach` and `vercel connect attach` commands above.",
      };
    case "attach-failed":
      return {
        reason: "Slackbot provisioning did not attach this project. Slack channel was not added.",
        followUp: "Finish event delivery with the `vercel connect attach` command above.",
      };
    case "create-failed":
      return {
        reason: "Slackbot creation failed.",
        followUp: "Add it later with `eve add channel/slack`.",
      };
  }
}

/** Effects used by Slack setup. */
export interface SlackSetupDeps {
  deriveSlackConnectorSlug: typeof deriveSlackConnectorSlug;
  ensureChannel: typeof ensureChannel;
  ensureVercelProject: typeof ensureVercelProject;
  provisionSlackbot: typeof provisionSlackbot;
  reconcileSlackUid: typeof reconcileSlackUid;
}

const defaultDeps: SlackSetupDeps = {
  deriveSlackConnectorSlug,
  ensureChannel,
  ensureVercelProject,
  provisionSlackbot,
  reconcileSlackUid,
};

async function chooseCredentials(
  context: IntegrationSetupContext,
): Promise<"vercel-connect" | "environment" | "cancelled"> {
  if (context.yes) return "vercel-connect";
  try {
    return (await context.ui.prompter.select<"vercel" | "portable">({
      message: "How would you like to configure Slack?",
      options: [
        { value: "vercel", label: "Set up Vercel Connect", hint: "Sign in and link this project" },
        {
          value: "portable",
          label: "Use portable credentials",
          hint: "Read Slack tokens from environment variables",
        },
      ],
    })) === "portable"
      ? "environment"
      : "vercel-connect";
  } catch (error) {
    if (error instanceof WizardCancelledError) return "cancelled";
    throw error;
  }
}

async function provisionSlack(
  context: IntegrationSetupContext,
  deps: SlackSetupDeps,
  slug: SlackConnectorSlug,
): Promise<Extract<ProvisionSlackbotResult, { state: "attached" }>> {
  const provisionOptions: ProvisionSlackbotOptions = {
    selectConnector: async (connectors, preferred) => {
      if (context.yes) return preferred ?? connectors[0]!;
      const selected = await context.ui.prompter.select<string>({
        message: "Which Slack app would you like to use?",
        options: [
          ...connectors.map((connector) => {
            const option: { value: string; label: string; hint?: string } = {
              value: connector.uid,
              label: `Use ${connector.uid}`,
            };
            if (connector.uid === preferred?.uid) option.hint = "Matches this agent";
            return option;
          }),
          { value: "create", label: "Create a new Slack app" },
        ],
        initialValue: preferred?.uid,
      });
      return selected === "create"
        ? "create"
        : connectors.find((connector) => connector.uid === selected)!;
    },
  };
  if (context.signal !== undefined) provisionOptions.signal = context.signal;
  if (context.ui.prompter.awaitChoice !== undefined) {
    provisionOptions.awaitChoice = context.ui.prompter.awaitChoice;
  }
  const result = await deps.provisionSlackbot(
    context.ui.prompter.log,
    context.appRoot,
    slug,
    undefined,
    provisionOptions,
  );
  context.signal?.throwIfAborted();
  if (result.state === "cancelled") throw new WizardCancelledError();
  if (result.state !== "attached") {
    const copy = slackbotFailureCopy(result);
    throw new Error(`${copy.reason} ${copy.followUp}`);
  }
  return result;
}

/** Runs the Slack setup flow. Exported for direct integration tests. */
export async function setupSlack(
  context: IntegrationSetupContext,
  deps: SlackSetupDeps = defaultDeps,
): Promise<IntegrationSetupResult> {
  const credentials = await chooseCredentials(context);
  if (credentials === "cancelled") return { kind: "cancelled" };
  if (credentials === "vercel-connect" && context.environment.vercel.kind === "unavailable") {
    throw new Error(
      "Vercel Connect requires an authenticated Vercel CLI. Run `vercel login`, then retry Slack setup.",
    );
  }

  const slug = await deps.deriveSlackConnectorSlug(context.appRoot);
  if (credentials === "environment") {
    const result = await deps.ensureChannel({
      projectRoot: context.appRoot,
      kind: "slack",
      slackConnectorSlug: slug,
      slackCredentials: "environment",
      force: context.force,
      skipDependencyMutation: true,
    });
    reportOverwrittenFiles(context.ui.prompter.log, result.filesOverwritten);
    context.ui.prompter.log.success("Scaffolded channel: slack");
    context.ui.nextSteps([
      "Set SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET in .env.local (listed in .env.example).",
      "Configure your Slack app to send events to /eve/v1/slack on your public agent URL.",
    ]);
    return { kind: "done", deploymentRequired: true };
  }

  const project = await deps.ensureVercelProject({
    appRoot: context.appRoot,
    prompter: context.ui.prompter,
    signal: context.signal,
  });
  if (project.projectId.length === 0) throw new Error(SLACK_REQUIRES_VERCEL);
  const slackbot = await provisionSlack(context, deps, slug);
  const result = await deps.ensureChannel({
    projectRoot: context.appRoot,
    kind: "slack",
    slackConnectorUid: slackbot.connectorUid,
    slackConnectorSlug: slug,
    force: context.force,
    skipDependencyMutation: true,
  });
  reportOverwrittenFiles(context.ui.prompter.log, result.filesOverwritten);
  if (result.action === "skipped") {
    const ready = await deps.reconcileSlackUid(
      context.ui.prompter.log,
      context.appRoot,
      slackbot,
      `slack/${slug}`,
    );
    if (!ready) throw new Error("Slack connector UID update is required before deployment.");
  }
  context.ui.prompter.log.success("Scaffolded channel: slack");
  await installScaffoldDependencies({
    changed: result.packageJsonUpdated.length > 0,
    log: context.ui.prompter.log,
    projectPath: context.appRoot,
    signal: context.signal,
  });
  return {
    kind: "done",
    deploymentRequired: true,
    ...(slackbot.chatUrl === undefined
      ? {}
      : {
          productionDestinations: [
            { label: "Open Slack DM", url: slackMessageDeepLink(slackbot.chatUrl) },
          ],
        }),
  };
}

/** Slack setup registration. */
export const SLACK_SETUP: SetupIntegration = {
  kind: "slack",
  label: "Slack",
  hint: "Slack app mentions and DMs",
  setup: setupSlack,
};
