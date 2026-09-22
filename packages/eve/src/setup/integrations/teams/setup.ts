import { join } from "node:path";

import { text } from "#setup/ask.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import { runVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";
import { writeTextFile } from "#setup/scaffold/files.js";

import { provisionTeamsConnector } from "./connect.js";
import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";

export interface TeamsSetupDeps {
  provisionConnector: typeof provisionTeamsConnector;
  runVercel: typeof runVercel;
  runVercelCaptureStdout: typeof runVercelCaptureStdout;
  writeTextFile: typeof writeTextFile;
}

const defaultDeps: TeamsSetupDeps = {
  provisionConnector: provisionTeamsConnector,
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
  const project = await context.resolveVercelProject("Microsoft Teams");
  return { name: name.trim(), project };
}

export async function applyTeamsSetup(
  plan: TeamsSetupPlan,
  context: SetupApplyContext,
  deps: TeamsSetupDeps = defaultDeps,
) {
  const connector = await deps.provisionConnector({
    ...plan,
    log: context.presenter.log,
    projectRoot: context.projectRoot,
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
    "Deploy the agent.",
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
