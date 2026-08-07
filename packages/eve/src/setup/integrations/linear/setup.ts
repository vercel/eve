import { join } from "node:path";

import { select, text } from "#setup/ask.js";
import { ensureVercelProject } from "#setup/flows/ensure-vercel-project.js";
import { deriveSlackConnectorSlug, normalizeSlackConnectorSlug } from "#setup/scaffold/index.js";
import { writeTextFile } from "#setup/scaffold/files.js";
import { WizardCancelledError } from "#setup/step.js";

import type {
  IntegrationSetupContext,
  IntegrationSetupResult,
  SetupIntegration,
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
  ensureVercelProject: typeof ensureVercelProject;
  findConnector: typeof findLinearConnector;
  provisionConnector: typeof provisionLinearConnector;
  writeTextFile: typeof writeTextFile;
}

const defaultDeps: LinearSetupDeps = {
  attachConnector: attachLinearConnector,
  deriveConnectorSlug: deriveSlackConnectorSlug,
  ensureVercelProject,
  findConnector: findLinearConnector,
  provisionConnector: provisionLinearConnector,
  writeTextFile,
};

/** Linear does not allow its brand name in a managed app's name. */
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

async function chooseConnector(
  context: IntegrationSetupContext,
  deps: LinearSetupDeps,
  project: Awaited<ReturnType<typeof ensureVercelProject>>,
): Promise<LinearConnectorRef | undefined> {
  const defaultSlug = linearSafeConnectorSlug(await deps.deriveConnectorSlug(context.appRoot));
  const slug = linearSafeConnectorSlug(
    await context.ui.asker.ask(
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
  if (existing !== undefined) {
    const choice = await context.ui.asker.ask(
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
    if (choice === "exit") return undefined;
    if (choice === "reuse") {
      await deps.attachConnector({
        connector: existing,
        log: context.ui.prompter.log,
        project,
        projectRoot: context.appRoot,
        signal: context.signal,
      });
      return existing;
    }
  }

  const connectorSlug =
    existing === undefined
      ? slug
      : linearSafeConnectorSlug(
          await context.ui.asker.ask(
            text({
              key: "linear.new-connector-name",
              message: "Name the new Linear agent",
              recommended: `${slug}-2`,
              validate: (value) =>
                value.trim().length === 0 ? "A Linear agent name is required." : null,
            }),
          ),
        );
  return deps.provisionConnector({
    log: context.ui.prompter.log,
    project,
    projectRoot: context.appRoot,
    slug: connectorSlug,
    signal: context.signal,
  });
}

/** Runs guided Linear Agent Session connector and channel setup. */
export async function setupLinear(
  context: IntegrationSetupContext,
  deps: LinearSetupDeps = defaultDeps,
): Promise<IntegrationSetupResult> {
  if (context.environment.vercel.kind === "unavailable") {
    throw new Error(
      "Linear setup requires an authenticated Vercel CLI. Run `vercel login`, then retry.",
    );
  }
  try {
    const project = await deps.ensureVercelProject({
      appRoot: context.appRoot,
      prompter: context.ui.prompter,
      signal: context.signal,
      headless: context.headless,
    });
    const connector = await chooseConnector(context, deps, project);
    if (connector === undefined) return { kind: "cancelled" };
    await deps.writeTextFile(
      join(context.appRoot, "agent/channels/linear.ts"),
      connectTemplate(connector.uid),
      { force: context.force },
    );
    const dashboardUrl = "https://vercel.com/d?to=/%5Bteam%5D/~/connect&title=Open+Vercel+Connect";
    return {
      kind: "done",
      facts: [
        { label: "Vercel Connect", value: dashboardUrl, kind: "url" },
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
      ],
    };
  } catch (error) {
    if (error instanceof WizardCancelledError) return { kind: "cancelled" };
    throw error;
  }
}

/** Linear Agent Session setup registration. */
export const LINEAR_SETUP: SetupIntegration = {
  kind: "linear",
  label: "Linear Agent",
  hint: "Delegate Linear issues and comments",
  setup: setupLinear,
};
