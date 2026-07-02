import {
  CONNECTION_CATALOG,
  ensureConnectionDependencies,
  listAuthoredConnections,
} from "#setup/scaffold/index.js";
import { createPromptCommandOutput, withPhase } from "#setup/cli/index.js";
import { detectPackageManager } from "#setup/package-manager.js";
import { runPackageManagerInstall } from "#setup/primitives/pm/run.js";
import { toErrorMessage } from "#shared/errors.js";

import { interactiveAsker } from "../ask.js";
import { addConnections, type AddConnectionsDeps } from "../boxes/add-connections.js";
import { selectConnections } from "../boxes/select-connections.js";
import {
  detectDeployment,
  isProjectResolved,
  projectResolutionFromDeployment,
} from "../project-resolution.js";
import type { Prompter, SelectOption, SingleSelectOptions } from "../prompter.js";
import { runInteractive, type AnySetupBox } from "../runner.js";
import { snapshotSetupState, type SetupState } from "../state.js";
import { WizardCancelledError } from "../step.js";
import {
  getVercelAuthStatus,
  vercelAuthBlockerReason,
  type VercelAuthStatus,
} from "../vercel-project.js";
import { withSpinner } from "../with-spinner.js";

import { inProjectSetupState, prompterSink } from "./in-project.js";
import { runLinkFlow } from "./link.js";

export const CONNECTIONS_PROMPT_MESSAGE =
  "Select an MCP server to add to your agent through Vercel Connect";

const CONNECT_CONNECTIONS = CONNECTION_CATALOG.filter((entry) => entry.auth.kind === "connect");

export interface ConnectionsFlowDeps {
  detectDeployment: typeof detectDeployment;
  detectPackageManager: typeof detectPackageManager;
  getVercelAuthStatus: typeof getVercelAuthStatus;
  runLinkFlow: typeof runLinkFlow;
  ensureConnectionDependencies: typeof ensureConnectionDependencies;
  listAuthoredConnections: typeof listAuthoredConnections;
  runPackageManagerInstall: typeof runPackageManagerInstall;
  addConnections?: AddConnectionsDeps;
}

export type ConnectionsFlowResult =
  | { kind: "done"; addedConnections: readonly string[] }
  | { kind: "cancelled" }
  | { kind: "failed"; addedConnections: readonly string[]; message: string };

function connectionRows(
  authored: ReadonlySet<string>,
  authStatus: VercelAuthStatus,
  disabledConnectionReasons: Readonly<Record<string, string>>,
): SelectOption<string>[] {
  const blocker = vercelAuthBlockerReason(authStatus);
  const rows: SelectOption<string>[] = CONNECT_CONNECTIONS.map((entry) => {
    const row = { value: entry.slug, label: entry.label };
    if (authored.has(entry.slug)) {
      return { ...row, completed: true, focusHint: "Already added" };
    }
    const disabledConnectionReason = disabledConnectionReasons[entry.slug];
    if (disabledConnectionReason !== undefined) {
      return {
        ...row,
        disabled: true,
        disabledReason: disabledConnectionReason,
        disabledReasonTone: "warning",
      };
    }
    if (blocker !== undefined) {
      return {
        ...row,
        disabled: true,
        disabledReason: blocker,
        disabledReasonTone: "warning",
      };
    }
    return { ...row, hint: entry.hint };
  });
  rows.push({ value: "done", label: "Done", trailingAction: true });
  return rows;
}

async function pickConnection(
  prompter: Prompter,
  authored: ReadonlySet<string>,
  authStatus: VercelAuthStatus,
  disabledConnectionReasons: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  const options = connectionRows(authored, authStatus, disabledConnectionReasons);
  const request: SingleSelectOptions<string> = {
    message: CONNECTIONS_PROMPT_MESSAGE,
    options,
    hintLayout: "inline",
    search: true,
    placeholder: "type to search MCP servers",
  };
  if (
    !options.some(
      (option) => option.value !== "done" && option.disabled !== true && option.completed !== true,
    )
  ) {
    request.initialValue = "done";
  }
  try {
    return await prompter.select(request);
  } catch (error) {
    if (error instanceof WizardCancelledError) return undefined;
    throw error;
  }
}

/** Runs `/connect`, linking a project on first selection when needed. */
export async function runConnectionsFlow(input: {
  appRoot: string;
  prompter: Prompter;
  signal?: AbortSignal;
  disabledConnectionReasons?: Readonly<Record<string, string>>;
  deps?: Partial<ConnectionsFlowDeps>;
}): Promise<ConnectionsFlowResult> {
  const { appRoot, prompter, signal } = input;
  const deps: ConnectionsFlowDeps = {
    detectDeployment,
    detectPackageManager,
    ensureConnectionDependencies,
    getVercelAuthStatus,
    listAuthoredConnections,
    runLinkFlow,
    runPackageManagerInstall,
    ...input.deps,
  };
  const [deployment, initialAuthored, authStatus] = await withSpinner(
    prompter,
    "Checking the project…",
    () =>
      Promise.all([
        deps.detectDeployment(appRoot, { signal }),
        deps.listAuthoredConnections(appRoot),
        deps.getVercelAuthStatus(appRoot, { signal }),
      ]),
  );
  signal?.throwIfAborted();

  let state = inProjectSetupState(appRoot, projectResolutionFromDeployment(deployment));
  const authored = new Set(initialAuthored);
  const selected = await pickConnection(
    prompter,
    authored,
    authStatus,
    input.disabledConnectionReasons ?? {},
  );
  if (selected === undefined) return { kind: "cancelled" };
  if (selected === "done" || authored.has(selected)) {
    return { kind: "done", addedConnections: [] };
  }

  try {
    if (!isProjectResolved(state.project)) {
      const link = await deps.runLinkFlow({
        appRoot,
        prompter,
        signal,
        projectSelection: "create-or-link",
        teamSelectMessage: () =>
          "You need to link to a project to use Vercel Connect.\n\nSelect your team",
      });
      if (link.kind === "cancelled") return { kind: "cancelled" };

      const deploymentAfterLink = await withSpinner(prompter, "Checking the project…", () =>
        deps.detectDeployment(appRoot, { signal }),
      );
      const project = projectResolutionFromDeployment(deploymentAfterLink);
      if (!isProjectResolved(project)) throw new Error("Project link was not found after linking.");
      state = { ...state, project };
    }

    const packageManager = await deps.detectPackageManager(appRoot);
    await deps.ensureConnectionDependencies({ projectRoot: appRoot });
    const installed = await withPhase(
      prompter.log,
      `Installing connection dependencies (${packageManager.kind} install)...`,
      () =>
        deps.runPackageManagerInstall(packageManager.kind, appRoot, {
          onOutput: createPromptCommandOutput(prompter.log),
          signal,
        }),
    );
    if (!installed) {
      throw new Error(`Dependency installation failed. Run \`${packageManager.kind} install\`.`);
    }

    const boxes: AnySetupBox<SetupState>[] = [
      selectConnections({ asker: interactiveAsker(prompter), presetConnections: [selected] }),
      addConnections({ prompter, signal, deps: deps.addConnections }),
    ];

    const result = await runInteractive(boxes, state, prompterSink(prompter), {
      snapshot: snapshotSetupState,
      signal,
    });
    if (result.kind !== "done") return { kind: "cancelled" };

    const updatedAuthored = new Set(await deps.listAuthoredConnections(appRoot));
    if (!updatedAuthored.has(selected)) {
      throw new Error(`Connection "${selected}" was not added.`);
    }
    return { kind: "done", addedConnections: [selected] };
  } catch (error) {
    if (error instanceof WizardCancelledError) return { kind: "cancelled" };
    const updatedAuthored = new Set(await deps.listAuthoredConnections(appRoot));
    return {
      kind: "failed",
      addedConnections: updatedAuthored.has(selected) ? [selected] : [],
      message: toErrorMessage(error),
    };
  }
}
