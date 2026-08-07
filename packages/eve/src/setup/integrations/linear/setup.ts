import { join } from "node:path";

import { select, text } from "#setup/ask.js";
import { readProjectLink, type VercelProjectReference } from "#setup/project-resolution.js";
import { deriveSlackConnectorSlug, normalizeSlackConnectorSlug } from "#setup/scaffold/index.js";
import { writeTextFile } from "#setup/scaffold/files.js";
import { WizardCancelledError } from "#setup/step.js";

import { resolveIntegrationVercelProject } from "../shared/vercel-project.js";
import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";
import {
  attachLinearConnector,
  findLinearConnector,
  provisionLinearConnector,
  type LinearConnectorRef,
} from "./connect.js";

export interface LinearSetupDeps {
  attachConnector: typeof attachLinearConnector;
  deriveConnectorSlug: typeof deriveSlackConnectorSlug;
  readProjectLink: typeof readProjectLink;
  findConnector: typeof findLinearConnector;
  provisionConnector: typeof provisionLinearConnector;
  writeTextFile: typeof writeTextFile;
}

const defaultDeps: LinearSetupDeps = {
  attachConnector: attachLinearConnector,
  deriveConnectorSlug: deriveSlackConnectorSlug,
  readProjectLink,
  findConnector: findLinearConnector,
  provisionConnector: provisionLinearConnector,
  writeTextFile,
};

export function linearSafeConnectorSlug(slug: string): string {
  const withoutLinear = slug.replaceAll(/linear/gi, "").replace(/[-_]{2,}/g, "-");
  return normalizeSlackConnectorSlug(withoutLinear || "agent");
}

function connectTemplate(uid: string): string {
  return `import { connectLinearCredentials } from "@vercel/connect/eve";
import { linearChannel } from "eve/channels/linear";

export default linearChannel({
  credentials: connectLinearCredentials(${JSON.stringify(uid)}),
});
`;
}

type ConnectorPlan =
  | { kind: "reuse"; connector: LinearConnectorRef }
  | { kind: "create"; slug: string };

export interface LinearSetupPlan {
  connector: ConnectorPlan;
  project: VercelProjectReference;
}

export async function prepareLinearSetup(
  context: SetupPrepareContext,
  deps: LinearSetupDeps = defaultDeps,
): Promise<LinearSetupPlan> {
  if (context.environment.vercel.kind === "unavailable") {
    throw new Error(
      "Linear setup requires an authenticated Vercel CLI. Run `vercel login`, then retry.",
    );
  }
  const project = await resolveIntegrationVercelProject({
    appRoot: context.appRoot,
    integration: "Linear",
    signal: context.signal,
    deps,
  });
  const defaultSlug = linearSafeConnectorSlug(await deps.deriveConnectorSlug(context.appRoot));
  const slug = linearSafeConnectorSlug(
    await context.asker.ask(
      text({
        key: "linear.connector-name",
        message: "Name your Linear agent",
        recommended: defaultSlug,
        validate: (value) =>
          value.trim().length === 0 ? "A Linear agent name is required." : null,
      }),
    ),
  );
  const existing = await deps.findConnector({
    project,
    projectRoot: context.appRoot,
    slug,
    signal: context.signal,
  });
  if (existing === undefined) return { project, connector: { kind: "create", slug } };
  const choice = await context.asker.ask(
    select({
      key: "linear.existing-connector",
      message: `A Linear connector named "${slug}" already exists. What would you like to do?`,
      options: [
        { id: "reuse", label: "Reuse existing connector", value: "reuse" as const },
        { id: "new", label: "Create a new connector", value: "new" as const },
        { id: "exit", label: "Exit setup", value: "exit" as const },
      ],
      recommended: "reuse" as const,
    }),
  );
  if (choice === "exit") throw new WizardCancelledError();
  if (choice === "reuse") return { project, connector: { kind: "reuse", connector: existing } };
  const newSlug = linearSafeConnectorSlug(
    await context.asker.ask(
      text({
        key: "linear.new-connector-name",
        message: "Name the new Linear agent",
        recommended: `${slug}-2`,
        validate: (value) =>
          value.trim().length === 0 ? "A Linear agent name is required." : null,
      }),
    ),
  );
  return { project, connector: { kind: "create", slug: newSlug } };
}

export async function applyLinearSetup(
  plan: LinearSetupPlan,
  context: SetupApplyContext,
  deps: LinearSetupDeps = defaultDeps,
) {
  const connector =
    plan.connector.kind === "reuse"
      ? (await deps.attachConnector({
          connector: plan.connector.connector,
          log: context.presenter.log,
          project: plan.project,
          projectRoot: context.appRoot,
          signal: context.signal,
        }),
        plan.connector.connector)
      : await deps.provisionConnector({
          log: context.presenter.log,
          project: plan.project,
          projectRoot: context.appRoot,
          slug: plan.connector.slug,
          signal: context.signal,
        });
  await deps.writeTextFile(
    join(context.appRoot, "agent/channels/linear.ts"),
    connectTemplate(connector.uid),
    { force: context.force },
  );
  const dashboardUrl = "https://vercel.com/d?to=/%5Bteam%5D/~/connect&title=Open+Vercel+Connect";
  return {
    facts: [
      { label: "Vercel Connect", value: dashboardUrl, kind: "url" as const },
      {
        label: "Next step",
        value:
          "Deploy the agent, then open the Linear app in Vercel Connect and install it in the workspace where you want to delegate issues and comments.",
      },
      {
        label: "In Linear",
        value:
          "Delegate an issue or mention the agent in an Agent Session to start a conversation.",
      },
      { label: "Open Linear", value: "https://linear.app", kind: "url" as const },
    ],
    deploymentRequired: true as const,
  };
}

export const LINEAR_SETUP = defineSetupIntegration({
  kind: "linear",
  label: "Linear Agent",
  hint: "Delegate Linear issues and comments",
  prepare: prepareLinearSetup,
  apply: applyLinearSetup,
});
