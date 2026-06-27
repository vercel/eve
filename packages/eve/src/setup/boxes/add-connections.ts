import {
  ensureConnection,
  listAuthoredConnections,
  type ConnectionInput,
  type ConnectionMutationResult,
} from "#setup/scaffold/index.js";
import type { ChannelSetupLog } from "#setup/cli/index.js";

import {
  cleanupCreatedConnectionConnector,
  setupConnectionConnector,
} from "../connection-connector.js";
import { canonicalConnectorNameForEntry } from "../scaffold/connections/catalog.js";
import {
  isProjectResolved,
  mergeProjectResolution,
  readProjectLink,
  type ProjectResolution,
} from "../project-resolution.js";
import type { Prompter } from "../prompter.js";
import { hasVercelProject, requireProjectPath, type SetupState } from "../state.js";
import type { SetupBox } from "../step.js";
import { projectIdFromResolution } from "../vercel-project.js";
import { CONNECT_REQUIRES_VERCEL } from "./select-connections.js";

/** Injected for tests; defaults to the real scaffold and Connect effects. */
export interface AddConnectionsDeps {
  ensureConnection: typeof ensureConnection;
  listAuthoredConnections: typeof listAuthoredConnections;
  readProjectLink: typeof readProjectLink;
  setupConnectionConnector: typeof setupConnectionConnector;
  cleanupCreatedConnectionConnector: typeof cleanupCreatedConnectionConnector;
}

export interface AddConnectionsOptions {
  /** Carries connector selection prompts and provisioning output. */
  prompter: Prompter;
  signal?: AbortSignal;
  deps?: AddConnectionsDeps;
}

function logFollowUp(log: ChannelSetupLog, result: ConnectionMutationResult): void {
  if (result.action === "skipped") {
    log.warning(`Skipped ${result.slug} (already exists; pass --force to overwrite).`);
    return;
  }
  log.success(`Added agent/connections/${result.slug}.ts`);
  if (result.envKeysAdded.length > 0) {
    log.info(`Set ${result.envKeysAdded.join(", ")} in .env.local`);
  } else if (result.envKeysRequired.length > 0) {
    log.info(`Set ${result.envKeysRequired.join(", ")} in your environment`);
  }
}

function withConnectorUid(entry: ConnectionInput, connectorUid: string): ConnectionInput {
  if (entry.auth?.kind !== "connect") {
    throw new Error(`Connection ${entry.slug} is not configured for Vercel Connect.`);
  }
  return { ...entry, auth: { ...entry.auth, connector: connectorUid } };
}

/**
 * THE CONNECTIONS BOX: executes the {@link ConnectionPlan}s the
 * select-connections box recorded during the interview. It scaffolds each file
 * and resolves the concrete Connect connector against the linked project.
 */
export function addConnections(
  options: AddConnectionsOptions,
): SetupBox<SetupState, null, ProjectResolution> {
  const deps = options.deps ?? {
    ensureConnection,
    listAuthoredConnections,
    readProjectLink,
    setupConnectionConnector,
    cleanupCreatedConnectionConnector,
  };

  return {
    id: "add-connections",

    shouldRun(state) {
      return state.connectionSelection.length > 0;
    },

    async gather(): Promise<null> {
      // No questions: the plans were resolved by the select-connections box.
      return null;
    },

    async perform({ state }): Promise<ProjectResolution> {
      const log = options.prompter.log;
      const projectRoot = requireProjectPath(state);
      const noVercel = !hasVercelProject(state);
      const project = state.project;
      const authored = new Set(await deps.listAuthoredConnections(projectRoot));

      for (const plan of state.connectionSelection) {
        if (authored.has(plan.slug)) {
          const result = await deps.ensureConnection({
            projectRoot,
            slug: plan.slug,
            protocol: plan.protocol,
            entry: plan.entry,
          });
          logFollowUp(log, result);
          continue;
        }

        let entry = plan.entry;
        let createdConnectorId: string | undefined;

        switch (plan.provision.kind) {
          case "connect": {
            const canonicalConnectorName = canonicalConnectorNameForEntry(plan.entry);
            if (canonicalConnectorName === undefined) {
              throw new Error(`Connection ${plan.slug} has no canonical connector name.`);
            }
            const connector = await deps.setupConnectionConnector({
              log,
              prompter: options.prompter,
              projectRoot,
              slug: plan.slug,
              service: plan.provision.service,
              canonicalConnectorName,
              project: await resolveConnectionProject({
                noVercel,
                project,
                projectRoot,
                readProjectLink: deps.readProjectLink,
              }),
              signal: options.signal,
            });
            entry = withConnectorUid(entry, connector.connectorUid);
            if (connector.kind === "created") createdConnectorId = connector.connectorId;
            break;
          }
          case "command-hint":
            log.info(
              `Run \`vercel connect create ${plan.provision.service} --name ${plan.slug}\`, then set the connector UID in agent/connections/${plan.slug}.ts.`,
            );
            break;
          case "connect-manual":
            log.warning(
              `Could not determine a Connect service for ${plan.slug}. Create the connector manually and set its UID in agent/connections/${plan.slug}.ts.`,
            );
            break;
          case "none":
            break;
        }

        let result: ConnectionMutationResult;
        try {
          result = await deps.ensureConnection({
            projectRoot,
            slug: plan.slug,
            protocol: plan.protocol,
            entry,
          });
        } catch (error) {
          if (createdConnectorId !== undefined) {
            try {
              await deps.cleanupCreatedConnectionConnector({
                log,
                projectRoot,
                connectorId: createdConnectorId,
              });
            } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                `${error instanceof Error ? error.message : String(error)} ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
              );
            }
          }
          throw error;
        }
        if (result.action === "skipped" && createdConnectorId !== undefined) {
          await deps.cleanupCreatedConnectionConnector({
            log,
            projectRoot,
            connectorId: createdConnectorId,
          });
        }
        logFollowUp(log, result);
        if (result.action !== "skipped") authored.add(result.slug);
      }
      return project;
    },

    apply(state, payload) {
      return { ...state, project: mergeProjectResolution(state.project, payload) };
    },
  };
}

async function resolveConnectionProject(input: {
  noVercel: boolean;
  project: ProjectResolution;
  projectRoot: string;
  readProjectLink: typeof readProjectLink;
}) {
  if (input.noVercel) {
    throw new Error(CONNECT_REQUIRES_VERCEL);
  }
  if (!isProjectResolved(input.project)) {
    throw new Error("Expected a linked Vercel project for Connect, but none was resolved.");
  }

  const linkedProject = await input.readProjectLink(input.projectRoot);
  if (
    linkedProject === undefined ||
    linkedProject.projectId !== projectIdFromResolution(input.project)
  ) {
    throw new Error("A linked Vercel project is required. Run `eve link`, then retry /connect.");
  }
  return linkedProject;
}
