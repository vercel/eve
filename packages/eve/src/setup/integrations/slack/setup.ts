import { select } from "#setup/ask.js";
import { readProjectLink, type VercelProjectReference } from "#setup/project-resolution.js";
import {
  deriveSlackConnectorSlug,
  ensureChannel,
  type SlackConnectorSlug,
} from "#setup/scaffold/index.js";
import {
  inspectSlackbotConnectors,
  provisionSlackbot,
  reconcileSlackUid,
  type ProvisionSlackbotResult,
  type SlackConnectorRef,
  type SlackConnectorSelection,
} from "#setup/slackbot.js";
import { slackMessageDeepLink } from "#setup/slack-connect.js";
import { WizardCancelledError } from "#setup/step.js";

import { installScaffoldDependencies, reportOverwrittenFiles } from "../shared/scaffold.js";
import { resolveIntegrationVercelProject } from "../shared/vercel-project.js";
import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
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

export interface SlackSetupDeps {
  deriveSlackConnectorSlug: typeof deriveSlackConnectorSlug;
  ensureChannel: typeof ensureChannel;
  inspectConnectors: typeof inspectSlackbotConnectors;
  readProjectLink: typeof readProjectLink;
  provisionSlackbot: typeof provisionSlackbot;
  reconcileSlackUid: typeof reconcileSlackUid;
}

const defaultDeps: SlackSetupDeps = {
  deriveSlackConnectorSlug,
  ensureChannel,
  inspectConnectors: inspectSlackbotConnectors,
  readProjectLink,
  provisionSlackbot,
  reconcileSlackUid,
};

type SlackSetupPlan =
  | { credentials: "environment"; slug: SlackConnectorSlug }
  | {
      credentials: "vercel-connect";
      slug: SlackConnectorSlug;
      project: VercelProjectReference;
      connector: SlackConnectorSelection;
    };

async function chooseConnector(
  context: SetupPrepareContext,
  connectors: readonly SlackConnectorRef[],
  preferred: SlackConnectorRef | undefined,
): Promise<SlackConnectorSelection> {
  if (connectors.length === 0) return "create";
  return context.asker.ask(
    select({
      key: "slack-connector",
      message: "Which Slack app would you like to use?",
      options: [
        ...connectors.map((connector) => ({
          id: connector.uid,
          value: connector,
          label: `Use ${connector.uid}`,
          hint: connector.uid === preferred?.uid ? "Matches this agent" : undefined,
        })),
        { id: "create", value: "create" as const, label: "Create a new Slack app" },
      ],
      recommended: preferred ?? connectors[0] ?? ("create" as const),
      required: true,
    }),
  );
}

export async function prepareSlackSetup(
  context: SetupPrepareContext,
  deps: SlackSetupDeps = defaultDeps,
): Promise<SlackSetupPlan> {
  const credentials = await context.asker.ask(
    select({
      key: "slack-credentials",
      message: "How would you like to configure Slack?",
      options: [
        {
          id: "vercel",
          value: "vercel-connect" as const,
          label: "Set up Vercel Connect",
          hint: "Use a linked Vercel project",
        },
        {
          id: "portable",
          value: "environment" as const,
          label: "Use portable credentials",
          hint: "Read Slack tokens from environment variables",
        },
      ],
      recommended: "vercel-connect" as const,
      required: true,
    }),
  );
  const slug = await deps.deriveSlackConnectorSlug(context.appRoot);
  if (credentials === "environment") return { credentials, slug };
  if (context.environment.vercel.kind === "unavailable") {
    throw new Error(
      "Vercel Connect requires an authenticated Vercel CLI. Run `vercel login`, then retry Slack setup.",
    );
  }
  const project = await resolveIntegrationVercelProject({
    appRoot: context.appRoot,
    integration: "Slack",
    signal: context.signal,
    deps,
  });
  if (project.projectId.length === 0) throw new Error(SLACK_REQUIRES_VERCEL);
  const lookup = await deps.inspectConnectors(
    context.presentation.log,
    context.appRoot,
    slug,
    context.signal,
  );
  const connector =
    lookup.state === "found"
      ? await chooseConnector(context, lookup.connectors, lookup.preferred)
      : "create";
  return { credentials, slug, project, connector };
}

export async function applySlackSetup(
  plan: SlackSetupPlan,
  context: SetupApplyContext,
  deps: SlackSetupDeps = defaultDeps,
) {
  if (plan.credentials === "environment") {
    const result = await deps.ensureChannel({
      projectRoot: context.appRoot,
      kind: "slack",
      slackConnectorSlug: plan.slug,
      slackCredentials: "environment",
      force: context.force,
      skipDependencyMutation: true,
    });
    reportOverwrittenFiles(context.presentation.log, result.filesOverwritten);
    context.presentation.log.success("Scaffolded channel: slack");
    context.presentation.nextSteps([
      "Set SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET in .env.local (listed in .env.example).",
      "Configure your Slack app to send events to /eve/v1/slack on your public agent URL.",
    ]);
    return { facts: [], deploymentRequired: true as const };
  }
  const result = await deps.provisionSlackbot(
    context.presentation.log,
    context.appRoot,
    plan.slug,
    undefined,
    {
      signal: context.signal,
      selectConnector: async () => plan.connector,
    },
  );
  context.signal?.throwIfAborted();
  if (result.state === "cancelled") throw new WizardCancelledError();
  if (result.state !== "attached") {
    const copy = slackbotFailureCopy(result);
    throw new Error(`${copy.reason} ${copy.followUp}`);
  }
  const channel = await deps.ensureChannel({
    projectRoot: context.appRoot,
    kind: "slack",
    slackConnectorUid: result.connectorUid,
    slackConnectorSlug: plan.slug,
    force: context.force,
    skipDependencyMutation: true,
  });
  reportOverwrittenFiles(context.presentation.log, channel.filesOverwritten);
  if (channel.action === "skipped") {
    const ready = await deps.reconcileSlackUid(
      context.presentation.log,
      context.appRoot,
      result,
      `slack/${plan.slug}`,
    );
    if (!ready) throw new Error("Slack connector UID update is required before deployment.");
  }
  context.presentation.log.success("Scaffolded channel: slack");
  await installScaffoldDependencies({
    changed: channel.packageJsonUpdated.length > 0,
    log: context.presentation.log,
    projectPath: context.appRoot,
    signal: context.signal,
  });
  return {
    facts:
      result.chatUrl === undefined
        ? []
        : [
            {
              label: "Open Slack DM",
              value: slackMessageDeepLink(result.chatUrl),
              kind: "url" as const,
            },
          ],
    deploymentRequired: true as const,
  };
}

export const SLACK_SETUP = defineSetupIntegration({
  kind: "slack",
  label: "Slack",
  hint: "Slack app mentions and DMs",
  prepare: prepareSlackSetup,
  apply: applySlackSetup,
});
