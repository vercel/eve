import { join } from "node:path";

import { confirm, text } from "#setup/ask.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import { writeTextFile } from "#setup/scaffold/files.js";

import { attachTeamsTrigger, createManagedTeamsConnector, readTeamsConnector } from "./connect.js";
import { openUrl } from "#setup/primitives/open-url.js";
import { runVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";
import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";

export interface TeamsSetupDeps {
  attachTrigger: typeof attachTeamsTrigger;
  createConnector: typeof createManagedTeamsConnector;
  readConnector: typeof readTeamsConnector;
  openUrl: typeof openUrl;
  runVercel: typeof runVercel;
  runVercelCaptureStdout: typeof runVercelCaptureStdout;
  writeTextFile: typeof writeTextFile;
}

const defaultDeps: TeamsSetupDeps = {
  attachTrigger: attachTeamsTrigger,
  createConnector: createManagedTeamsConnector,
  readConnector: readTeamsConnector,
  openUrl,
  runVercel,
  runVercelCaptureStdout,
  writeTextFile,
};

function connectTemplate(uid: string): string {
  return `import { connectTeamsCredentials } from "@vercel/connect/eve";
import { teamsChannel } from "eve/channels/teams";

export default teamsChannel({
  credentials: connectTeamsCredentials(${JSON.stringify(uid)}),
});
`;
}

export interface TeamsSetupPlan {
  name: string;
  project: VercelProjectReference;
  resourceGroup?: string;
  subscriptionId: string;
}

export async function prepareTeamsSetup(context: SetupPrepareContext): Promise<TeamsSetupPlan> {
  const name = await context.asker.ask(
    text({
      key: "teams.bot-name",
      message: "Microsoft Teams bot name",
      detected: "eve agent",
      required: true,
      validate: (value) => (value.trim().length === 0 ? "A bot name is required." : null),
    }),
  );
  const subscriptionId = await context.asker.ask(
    text({
      key: "teams.azure-subscription-id",
      message: "Azure subscription ID",
      required: true,
      validate: (value) =>
        value.trim().length === 0 ? "An Azure subscription ID is required." : null,
    }),
  );
  const resourceGroup = await context.asker.ask(
    text({
      key: "teams.azure-resource-group",
      message: "Azure resource group (optional)",
      placeholder: "eve-bots",
    }),
  );
  const project = await context.resolveVercelProject("Microsoft Teams");
  const trimmedResourceGroup = resourceGroup?.trim() ?? "";
  return {
    name: name.trim(),
    project,
    ...(trimmedResourceGroup.length === 0 ? {} : { resourceGroup: trimmedResourceGroup }),
    subscriptionId: subscriptionId.trim(),
  };
}

export async function applyTeamsSetup(
  plan: TeamsSetupPlan,
  context: SetupApplyContext,
  deps: TeamsSetupDeps = defaultDeps,
) {
  const created = await deps.createConnector({
    ...plan,
    log: context.presenter.log,
    projectRoot: context.appRoot,
    signal: context.signal,
    deps,
  });
  const action = context.presenter.beginExternalAction({
    message: "Authorize Microsoft Teams bot creation",
    url: created.url,
  });
  deps.openUrl(created.url);
  try {
    const completed = await context.asker.ask(
      confirm({
        key: "teams.creation-complete",
        message: "Finish Microsoft sign-in and bot creation in your browser, then continue?",
        required: true,
      }),
    );
    if (!completed) throw new Error("Microsoft Teams bot creation was not completed.");
  } finally {
    action.complete();
  }

  const connector = await deps.readConnector({
    connectorId: created.connectorId,
    log: context.presenter.log,
    project: plan.project,
    projectRoot: context.appRoot,
    signal: context.signal,
    deps,
  });
  await deps.attachTrigger({
    connector,
    log: context.presenter.log,
    project: plan.project,
    projectRoot: context.appRoot,
    signal: context.signal,
    deps,
  });
  await deps.writeTextFile(
    join(context.appRoot, "agent/channels/teams.ts"),
    connectTemplate(connector.uid),
    { force: context.force },
  );
  context.presenter.log.success("Scaffolded channel: teams");
  context.presenter.nextSteps([
    "Deploy the agent, then add the Microsoft Teams app from Vercel Connect to the team or chat where you want to use it.",
    "Mention the bot in a channel, or send it a message in a personal chat.",
  ]);
  return { facts: [], deploymentRequired: true as const };
}

export const TEAMS_SETUP = defineSetupIntegration({
  kind: "teams",
  label: "Microsoft Teams",
  hint: "Managed Teams bot with Vercel Connect",
  prepare: prepareTeamsSetup,
  apply: applyTeamsSetup,
});
