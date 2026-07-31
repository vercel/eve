import { join } from "node:path";

import {
  cleanupCreatedConnectionConnector,
  setupConnectionConnector,
  type SetupConnectionConnectorOptions,
} from "#setup/connection-connector.js";
import { runLinkFlow, type LinkFlowDeps } from "#setup/flows/link.js";
import { readProjectLink } from "#setup/project-resolution.js";
import { createPrompter, type Prompter } from "#setup/prompter.js";
import { createRegistrySetupClient } from "#setup/registry-setup-client.js";
import { isEveProject } from "#setup/scaffold/index.js";
import { updateConnectionConnectorUid } from "#setup/scaffold/update/update-connection-connector.js";

import { NOT_AN_AGENT_MESSAGE } from "./preconditions.js";
import type { RegistryCommandLogger } from "./registry.js";

export interface IntegrationConnectOptions {
  signal?: AbortSignal;
}

export interface IntegrationConnectDependencies {
  createPrompter?: () => Prompter;
  readProjectLink: typeof readProjectLink;
  runLinkFlow: typeof runLinkFlow;
  linkFlowDeps?: Partial<LinkFlowDeps>;
  setupConnectionConnector: typeof setupConnectionConnector;
  cleanupCreatedConnectionConnector: typeof cleanupCreatedConnectionConnector;
  updateConnectionConnectorUid: typeof updateConnectionConnectorUid;
}

const defaultDependencies: IntegrationConnectDependencies = {
  readProjectLink,
  runLinkFlow,
  setupConnectionConnector,
  cleanupCreatedConnectionConnector,
  updateConnectionConnectorUid,
};

/** Configures the Vercel Connect connector referenced by an installed connection item. */
export async function runIntegrationConnect(input: {
  appRoot: string;
  slug: string;
  service: string;
  canonicalConnectorName?: string;
  options?: IntegrationConnectOptions;
  dependencies?: Partial<IntegrationConnectDependencies>;
}): Promise<void> {
  const dependencies = { ...defaultDependencies, ...input.dependencies };
  const prompter = dependencies.createPrompter?.() ?? createPrompter();
  const signal = input.options?.signal;
  prompter.intro(`Set up ${input.slug}`);

  let project = await dependencies.readProjectLink(input.appRoot);
  if (project === undefined) {
    const link = await dependencies.runLinkFlow({
      appRoot: input.appRoot,
      prompter,
      signal,
      projectSelection: "create-or-link",
      teamSelectMessage: () =>
        `You need to link to a project to use ${input.slug} through Vercel Connect.\n\nSelect your team`,
      deps: dependencies.linkFlowDeps,
    });
    if (link.kind === "cancelled") return;
    project = await dependencies.readProjectLink(input.appRoot);
    if (project === undefined) throw new Error("Project link was not found after linking.");
  }

  const connectorOptions: SetupConnectionConnectorOptions = {
    log: prompter.log,
    prompter,
    projectRoot: input.appRoot,
    slug: input.slug,
    service: input.service,
    canonicalConnectorName: input.canonicalConnectorName ?? input.slug,
    project,
    signal,
  };
  const connector = await dependencies.setupConnectionConnector(connectorOptions);
  const filePath = join(input.appRoot, "agent", "connections", `${input.slug}.ts`);
  const patched = await dependencies.updateConnectionConnectorUid(filePath, connector.connectorUid);
  if (!patched.patched) {
    if (connector.kind === "created") {
      await dependencies.cleanupCreatedConnectionConnector({
        log: prompter.log,
        projectRoot: input.appRoot,
        connectorId: connector.connectorId,
        orgId: project.orgId,
      });
    }
    throw new Error(`Could not update the connector in agent/connections/${input.slug}.ts.`);
  }
  prompter.outro(`Connection ${input.slug} set up.`);
}

/** CLI adapter for the hidden integration command used by trusted registry items. */
export async function runIntegrationConnectCommand(
  logger: RegistryCommandLogger,
  appRoot: string,
  slug: string,
  service: string,
  canonicalConnectorName: string | undefined,
  options: IntegrationConnectOptions = {},
  dependencies: IntegrationConnectDependencies = defaultDependencies,
): Promise<void> {
  if (!(await isEveProject(appRoot))) {
    logger.error(NOT_AN_AGENT_MESSAGE);
    process.exitCode = 1;
    return;
  }
  const client = createRegistrySetupClient({ signal: options.signal });
  try {
    await runIntegrationConnect({
      appRoot,
      slug,
      service,
      canonicalConnectorName,
      options,
      dependencies: {
        ...dependencies,
        createPrompter: () =>
          client?.prompter ?? dependencies.createPrompter?.() ?? createPrompter(),
      },
    });
    client?.complete();
  } catch (error) {
    client?.fail(error);
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
