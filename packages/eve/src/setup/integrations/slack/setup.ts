import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";

import { DEVELOPMENT_ENV_FILE_NAMES } from "#cli/dev/environment.js";
import { InvalidAnswerError, select } from "#setup/ask.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import {
  deriveSlackConnectorSlug,
  ensureChannel,
  type SlackConnectorSlug,
} from "#setup/scaffold/index.js";
import { readSlackChannelFile } from "#setup/scaffold/update/update-slack-channel.js";
import {
  connectorInUseMessage,
  inspectSlackbotConnectors,
  provisionSlackbot,
  reconcileSlackUid,
  type ProvisionSlackbotResult,
  type SlackbotConnectorInspection,
  type SlackConnectorCandidate,
  type SlackConnectorSelection,
} from "#setup/slackbot.js";
import { slackMessageDeepLink } from "#setup/slack-connect.js";
import { WizardCancelledError } from "#setup/step.js";

import { installScaffoldDependencies, reportOverwrittenFiles } from "../shared/scaffold.js";
import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";

const SLACK_REQUIRES_VERCEL = "Slack setup with Vercel Connect requires a linked Vercel project.";
const SLACK_CHANNEL_PATH = "agent/channels/slack.ts";
const SLACK_ENVIRONMENT_VARIABLES = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"] as const;
/** Above this many connectors the question offers a type-ahead filter. */
const SEARCHABLE_CONNECTOR_COUNT = 7;

type SlackbotFailure = Exclude<
  ProvisionSlackbotResult,
  { state: "attached" } | { state: "already-configured" } | { state: "cancelled" }
>;

function slackbotFailureCopy(result: SlackbotFailure): { reason: string; followUp: string } {
  switch (result.state) {
    case "not-installed":
      return {
        reason: "Slackbot is not connected to a Slack workspace. Slack channel was not added.",
        followUp: "Re-run `eve add channel/slack` after the workspace install is complete.",
      };
    case "cleanup-failed": {
      if (result.connectorUids.length === 0) {
        return {
          reason:
            "eve couldn't confirm that the Slack setup in your browser ended. Slack channel was not added.",
          followUp:
            "Close the Slack setup page in your browser, wait a few minutes for the request to expire, then re-run `eve add channel/slack`.",
        };
      }
      const uids = result.connectorUids.map((uid) => `\`${uid}\``).join(", ");
      return {
        reason: `eve could not remove the Slack connector this attempt may have created (${uids}). Slack channel was not added.`,
        followUp: `Check that no other project uses it, remove it with \`vercel connect remove <uid> --disconnect-all --yes\`, then re-run \`eve add channel/slack\`.`,
      };
    }
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
          "The Slack connector is not installed in a Slack workspace yet. Slack channel was not added.",
        followUp: "Re-run `eve add channel/slack` to open its install page again.",
      };
    case "connector-in-use":
      return {
        reason: `${result.connectorUid} is used by another project. Slack channel was not added.`,
        followUp: "Re-run `eve add channel/slack` and create a new Slack app for this agent.",
      };
    case "trigger-limit-reached":
      return {
        reason: `${result.connectorUid} already has the maximum number of trigger destinations. Slack channel was not added.`,
        followUp:
          "Remove one destination in the Connect dashboard, then re-run `eve add channel/slack`.",
      };
    case "attach-failed":
      return {
        reason:
          "Slackbot provisioning did not finish event delivery for this project. Slack channel was not added.",
        followUp: "Re-run `eve add channel/slack` to finish the remaining steps.",
      };
    case "create-failed":
      return result.detail === undefined
        ? {
            reason: "Vercel could not create the Slack connector. Slack channel was not added.",
            followUp: "Re-run `eve add channel/slack` to try again.",
          }
        : {
            reason: `Vercel could not create the Slack connector: ${result.detail} Slack channel was not added.`,
            followUp: "Fix the problem Vercel reported, then re-run `eve add channel/slack`.",
          };
  }
}

export interface SlackSetupDeps {
  deriveSlackConnectorSlug: typeof deriveSlackConnectorSlug;
  ensureChannel: typeof ensureChannel;
  inspectConnectors: typeof inspectSlackbotConnectors;
  provisionSlackbot: typeof provisionSlackbot;
  reconcileSlackUid: typeof reconcileSlackUid;
  readSlackChannelFile: typeof readSlackChannelFile;
  missingSlackEnvironment: (environmentRoot: string) => Promise<string[]>;
}

/** Slack variables unset in both the process and the local development env files. */
async function missingSlackEnvironment(environmentRoot: string): Promise<string[]> {
  const defined = new Set<string>();
  for (const fileName of DEVELOPMENT_ENV_FILE_NAMES) {
    let source: string;
    try {
      source = await readFile(join(environmentRoot, fileName), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const [key, value] of Object.entries(parseEnv(source))) {
      if (value) defined.add(key);
    }
  }
  return SLACK_ENVIRONMENT_VARIABLES.filter((name) => !process.env[name] && !defined.has(name));
}

const defaultDeps: SlackSetupDeps = {
  deriveSlackConnectorSlug,
  ensureChannel,
  inspectConnectors: inspectSlackbotConnectors,
  provisionSlackbot,
  reconcileSlackUid,
  readSlackChannelFile,
  missingSlackEnvironment,
};

type SlackSetupPlan =
  | { credentials: "environment"; slug: SlackConnectorSlug }
  /** The channel file already exists and isn't Connect-backed; setup leaves it alone. */
  | { credentials: "existing-file"; file: "environment"; missing: readonly string[] }
  | { credentials: "existing-file"; file: "custom" }
  | {
      credentials: "vercel-connect";
      slug: SlackConnectorSlug;
      project: VercelProjectReference;
      connector: SlackConnectorSelection;
      /** UID the existing channel file names; patched when another connector is chosen. */
      channelConnectorUid: string | undefined;
    };

function connectorHint(
  candidate: SlackConnectorCandidate,
  preferred: SlackConnectorCandidate | undefined,
  channelConnectorUid: string | undefined,
): string {
  const parts: string[] = [];
  if (candidate.uid === channelConnectorUid) parts.push(`Named in ${SLACK_CHANNEL_PATH}`);
  else if (candidate.uid === preferred?.uid) parts.push("Matches this agent");
  parts.push(candidate.attached ? "attached" : "eve will attach it to this project");
  if (candidate.workspace === undefined) parts.push("not installed in a Slack workspace");
  if (candidate.otherProjects.length > 0) {
    const names = candidate.otherProjects.map((project) => project.name ?? project.id);
    parts.push(`also used by ${names.join(", ")}`);
  }
  return parts.join(" · ");
}

async function chooseConnector(
  context: SetupPrepareContext,
  inspection: SlackbotConnectorInspection,
  teamScope: string,
  channelConnectorUid: string | undefined,
  expectedUid: string,
): Promise<SlackConnectorSelection> {
  const { candidates, preferred } = inspection;
  if (candidates.length === 0) return "create";
  try {
    return await context.asker.ask<SlackConnectorSelection>(
      select({
        key: "slack-connector",
        message: "Which Slack app would you like to use?",
        options: [
          ...candidates.map((candidate) => ({
            id: candidate.uid,
            value: candidate,
            label: `Use ${candidate.uid}`,
            hint: connectorHint(candidate, preferred, channelConnectorUid),
          })),
          { id: "create", value: "create" as const, label: "Create a new Slack app" },
        ],
        recommended: preferred ?? ("create" as const),
        required: true,
        search: candidates.length > SEARCHABLE_CONNECTOR_COUNT,
        placeholder: "type to search Slack apps",
      }),
    );
  } catch (error) {
    if (!(error instanceof InvalidAnswerError)) throw error;
    throw new InvalidAnswerError(
      error.question,
      `${error.message} Searched Slack connectors in team ${teamScope}. eve reuses a Slack app only when it is attached to this project, or named ${expectedUid} and unused by other projects.`,
    );
  }
}

async function askCredentials(context: SetupPrepareContext) {
  return context.asker.ask(
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
}

/**
 * Reads what is already in place before asking anything, so a re-run only
 * asks the questions an earlier attempt left open. A channel file that names
 * a connector settles the credential and connector questions.
 */
export async function prepareSlackSetup(
  context: SetupPrepareContext,
  deps: SlackSetupDeps = defaultDeps,
): Promise<SlackSetupPlan> {
  const channelFile = await deps.readSlackChannelFile(join(context.appRoot, SLACK_CHANNEL_PATH));
  if (!context.force && channelFile.kind === "environment") {
    return {
      credentials: "existing-file",
      file: "environment",
      missing: await deps.missingSlackEnvironment(context.projectRoot),
    };
  }
  if (!context.force && channelFile.kind === "custom") {
    return { credentials: "existing-file", file: "custom" };
  }
  const channelConnectorUid = channelFile.kind === "connect" ? channelFile.connectorUid : undefined;
  const resuming = !context.force && channelConnectorUid !== undefined;
  if (!resuming) {
    const credentials = await askCredentials(context);
    if (credentials === "environment") {
      return { credentials, slug: await deps.deriveSlackConnectorSlug(context.appRoot) };
    }
  }
  const slug = await deps.deriveSlackConnectorSlug(context.appRoot);
  const project = await context.resolveVercelProject("Slack");
  if (project.projectId.length === 0) throw new Error(SLACK_REQUIRES_VERCEL);
  const inspection = await deps.inspectConnectors(
    context.presenter.log,
    context.projectRoot,
    slug,
    {
      signal: context.signal,
      channelConnectorUid,
    },
  );
  let connector: SlackConnectorSelection | undefined;
  if (resuming) {
    const inUse = inspection.inUse.find((candidate) => candidate.uid === channelConnectorUid);
    if (inUse !== undefined) {
      throw new Error(
        `${SLACK_CHANNEL_PATH} names ${connectorInUseMessage(inUse)} Re-run \`eve add channel/slack --overwrite\` to replace the channel file.`,
      );
    }
    connector = inspection.candidates.find((candidate) => candidate.uid === channelConnectorUid);
    if (connector === undefined) {
      context.presenter.log.warning(
        `${SLACK_CHANNEL_PATH} names \`${channelConnectorUid}\`, which was not found in team ${project.orgId}. Choose a Slack app and eve will update the channel file.`,
      );
    }
  }
  connector ??= await chooseConnector(
    context,
    inspection,
    project.orgId,
    channelConnectorUid,
    `slack/${slug}`,
  );
  return {
    credentials: "vercel-connect",
    slug,
    project,
    connector,
    channelConnectorUid,
  };
}

function reportExistingFile(
  plan: Extract<SlackSetupPlan, { credentials: "existing-file" }>,
  context: SetupApplyContext,
) {
  const { log } = context.presenter;
  if (plan.file === "custom") {
    log.info(
      `${SLACK_CHANNEL_PATH} already configures its own Slack credentials, so eve left it unchanged. Re-run with \`--overwrite\` to replace it with a Vercel Connect channel.`,
    );
  } else if (plan.missing.length === 0) {
    log.success(`${SLACK_CHANNEL_PATH} already uses portable Slack credentials.`);
  } else {
    log.warning(
      `${SLACK_CHANNEL_PATH} reads Slack credentials from environment variables, but ${plan.missing.join(" and ")} ${plan.missing.length === 1 ? "is" : "are"} not set. eve left the channel file unchanged.`,
    );
    context.presenter.nextSteps([
      `Set ${plan.missing.join(" and ")} in .env.local and in the deployment environment.`,
      "To switch to Vercel Connect instead, re-run `eve add channel/slack --overwrite`.",
    ]);
  }
  return { facts: [] };
}

export async function applySlackSetup(
  plan: SlackSetupPlan,
  context: SetupApplyContext,
  deps: SlackSetupDeps = defaultDeps,
) {
  if (plan.credentials === "existing-file") return reportExistingFile(plan, context);
  if (plan.credentials === "environment") {
    const result = await deps.ensureChannel({
      projectRoot: context.appRoot,
      environmentRoot: context.projectRoot,
      kind: "slack",
      slackConnectorSlug: plan.slug,
      slackCredentials: "environment",
      force: context.force,
      skipDependencyMutation: true,
    });
    reportOverwrittenFiles(context.presenter.log, result.filesOverwritten);
    context.presenter.log.success("Scaffolded channel: slack");
    context.presenter.nextSteps([
      "Set SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET in .env.local (listed in .env.example).",
      "Configure your Slack app to send events to /eve/v1/slack on your public agent URL.",
    ]);
    return { facts: [], deploymentRequired: true as const };
  }
  const result = await deps.provisionSlackbot(
    context.presenter.log,
    context.projectRoot,
    plan.slug,
    undefined,
    {
      signal: context.signal,
      selectConnector: async () => plan.connector,
      channelConnectorUid: plan.channelConnectorUid,
    },
  );
  context.signal?.throwIfAborted();
  if (result.state === "cancelled") throw new WizardCancelledError();
  if (result.state !== "attached" && result.state !== "already-configured") {
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
  reportOverwrittenFiles(context.presenter.log, channel.filesOverwritten);
  const unchanged =
    channel.action === "skipped" &&
    result.state === "already-configured" &&
    result.connectorUid === plan.channelConnectorUid;
  if (channel.action === "skipped") {
    const ready = await deps.reconcileSlackUid(
      context.presenter.log,
      context.appRoot,
      result,
      plan.channelConnectorUid ?? `slack/${plan.slug}`,
    );
    if (!ready) throw new Error("Slack connector UID update is required before deployment.");
  }
  context.presenter.log.success(
    unchanged
      ? `Slack is already set up with ${result.connectorUid}.`
      : "Scaffolded channel: slack",
  );
  await installScaffoldDependencies({
    changed: channel.packageJsonUpdated.length > 0,
    log: context.presenter.log,
    projectPath: context.projectRoot,
    signal: context.signal,
  });
  return {
    facts:
      result.chatUrl === undefined
        ? []
        : [
            {
              label: "Agent Slack DM",
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
