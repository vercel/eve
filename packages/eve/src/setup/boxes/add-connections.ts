import { ensureConnection, type ConnectionMutationResult } from "#setup/scaffold/index.js";
import type { ChannelSetupLog } from "#setup/cli/index.js";

import { setupConnectionConnector } from "../connection-connector.js";
import {
  isProjectResolved,
  mergeProjectResolution,
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
  setupConnectionConnector: typeof setupConnectionConnector;
}

export interface AddConnectionsOptions {
  /** Carries the follow-up log lines and `perform`'s progress output. The box never prompts. */
  prompter: Prompter;
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

/**
 * THE CONNECTIONS BOX: executes the {@link ConnectionPlan}s the
 * select-connections box recorded during the interview. Prompts for nothing —
 * every decision (slug, protocol, entry, provisioning mode) was resolved at
 * selection time — and only runs effects: the file scaffold, the follow-up log
 * lines, and the Connect connector provisioning against the linked project.
 */
export function addConnections(
  options: AddConnectionsOptions,
): SetupBox<SetupState, null, ProjectResolution> {
  const deps = options.deps ?? { ensureConnection, setupConnectionConnector };

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

      for (const plan of state.connectionSelection) {
        const result = await deps.ensureConnection({
          projectRoot,
          slug: plan.slug,
          protocol: plan.protocol,
          entry: plan.entry,
        });
        logFollowUp(log, result);
        // Whether the file already existed is only known at effect time; an
        // existing connection keeps its connector, so provisioning is skipped.
        if (result.action === "skipped") continue;

        switch (plan.provision.kind) {
          case "connect":
            await deps.setupConnectionConnector({
              log,
              projectRoot,
              slug: result.slug,
              service: plan.provision.service,
              connectionFilePath: result.filePath,
              // The project was linked up front by the link box; Connect
              // provisioning reuses it. The link box is a hard invariant once
              // Vercel is in play: an unresolved project here means it did not
              // run or did not record a resolution.
              linkProject: async () => {
                if (noVercel) {
                  throw new Error(CONNECT_REQUIRES_VERCEL);
                }
                if (!isProjectResolved(project)) {
                  throw new Error(
                    "Expected a linked Vercel project for Connect, but none was resolved.",
                  );
                }
                return projectIdFromResolution(project);
              },
            });
            break;
          case "command-hint":
            log.info(
              `Run \`vercel connect create ${plan.provision.service} --name ${result.slug}\`, then set the connector UID in agent/connections/${result.slug}.ts.`,
            );
            break;
          case "connect-manual":
            log.warning(
              `Could not determine a Connect service for ${result.slug}. Create the connector manually and set its UID in agent/connections/${result.slug}.ts.`,
            );
            break;
          case "none":
            break;
        }
      }
      return project;
    },

    apply(state, payload) {
      return { ...state, project: mergeProjectResolution(state.project, payload) };
    },
  };
}
