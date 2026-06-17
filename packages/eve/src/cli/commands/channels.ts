import { isEveProject, listAuthoredChannels, type ChannelKind } from "#setup/scaffold/index.js";

import { interactiveAsker } from "#setup/ask.js";
import { addChannels, type AddChannelsDeps } from "#setup/boxes/add-channels.js";
import { deployProject, type DeployProjectDeps } from "#setup/boxes/deploy-project.js";
import { selectChannels } from "#setup/boxes/select-channels.js";
import {
  detectDeployment,
  projectResolutionFromDeployment,
  type DeploymentInfo,
} from "#setup/project-resolution.js";
import { createPrompter, type Prompter } from "#setup/prompter.js";
import { runInteractive, type AnySetupBox } from "#setup/runner.js";
import { createDefaultSetupState, snapshotSetupState, type SetupState } from "#setup/state.js";
import type { OutputSink } from "#setup/step.js";

import {
  assertCanAddSelectedChannels,
  inspectExistingChannelRegistrations,
} from "./channel-add-conflicts.js";
import { NOT_AN_AGENT_MESSAGE } from "./preconditions.js";

export interface CliLogger {
  error(message: string): void;
  log(message: string): void;
}

const KNOWN_CHANNEL_KINDS: readonly ChannelKind[] = ["slack", "web"];

function isChannelKind(value: string): value is ChannelKind {
  return KNOWN_CHANNEL_KINDS.includes(value as ChannelKind);
}

function parseChannelKind(value: string): ChannelKind {
  if (!isChannelKind(value)) {
    throw new Error(`Unknown channel kind "${value}". Known: ${KNOWN_CHANNEL_KINDS.join(", ")}.`);
  }
  return value;
}

export interface AddChannelCommandOptions {
  force?: boolean;
  /** Assume yes for confirmations (slackbot creation). Requires an explicit kind. */
  yes?: boolean;
}

export interface ChannelsAddDependencies {
  createPrompter?: () => Prompter;
  detectDeployment(projectPath: string): Promise<DeploymentInfo>;
  /** Test seam into the add-channels box's scaffold/Connect/Vercel effects. */
  addChannelsDeps?: AddChannelsDeps;
  /** Test seam into the deploy box's subprocess effects. */
  deployProjectDeps?: DeployProjectDeps;
}

const defaultChannelsAddDependencies: ChannelsAddDependencies = {
  detectDeployment,
};

/**
 * `eve channels add` composes the channel picker, scaffold, and deploy boxes.
 * Its picker allows an empty submit and keeps Slack viable while unlinked;
 * conflict validation against existing authored registrations, the interactive
 * `vercel link` fallback inside the add-channels box, Vercel services config
 * pinned on, and build-stamped web package versions.
 */
async function runAddChannelsFlow(
  appRoot: string,
  kind: ChannelKind | undefined,
  options: AddChannelCommandOptions,
  dependencies: ChannelsAddDependencies,
): Promise<void> {
  if (kind === undefined && (options.yes || !process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error(
      `Pass a channel kind: \`eve channels add <${KNOWN_CHANNEL_KINDS.join("|")}>\`.`,
    );
  }

  const prompter = dependencies.createPrompter?.() ?? createPrompter();
  prompter.intro("Add channels to your eve agent");
  prompter.log.message("Checking the current Vercel project...");
  // The detected on-disk link is the only seeded fact; there are no onboarding
  // plans in this command, so the rest of the state keeps its defaults. The
  // default agentName ("") keeps deriveSlackConnectorSlug on its package.json
  // fallback instead of the directory basename, as the dissolved engine did.
  const state: SetupState = {
    ...createDefaultSetupState(),
    project: projectResolutionFromDeployment(await dependencies.detectDeployment(appRoot)),
    projectPath: { kind: "resolved", inPlace: true, path: appRoot },
  };
  let registrationInspection: ReturnType<typeof inspectExistingChannelRegistrations> | undefined;
  function inspectRegistrations() {
    if (registrationInspection === undefined) {
      prompter.log.message("Inspecting existing channel registrations...");
      registrationInspection = inspectExistingChannelRegistrations(appRoot);
    }
    return registrationInspection;
  }
  const disabledChannelReasons =
    kind === undefined ? (await inspectRegistrations()).disabledChannelReasons : undefined;

  const boxes: AnySetupBox<SetupState>[] = [
    selectChannels({
      // The picker only runs interactively: without a TTY the command fails
      // fast above unless a kind was passed, and a passed kind short-circuits
      // the question via presetChannels. So the interactive base suffices.
      asker: interactiveAsker(prompter),
      variant: "channels-add",
      presetChannels: kind === undefined ? undefined : [kind],
      disabledChannelReasons,
      validateSelection: async (selectedChannels) => {
        if (!selectedChannels.includes("web") && !selectedChannels.includes("slack")) {
          return;
        }
        assertCanAddSelectedChannels(selectedChannels, await inspectRegistrations());
      },
    }),
    addChannels({
      // The slackbot question only runs interactively here (a passed kind or
      // --yes short-circuits it), so the interactive base suffices, mirroring
      // the select-channels box above.
      asker: interactiveAsker(prompter),
      prompter,
      presetCreateSlackbot: options.yes ? true : undefined,
      force: options.force,
      // An unlinked directory still gets the Vercel services config (the engine
      // never gated it), and the link fallback keeps unlinked Slack viable.
      configureVercelServices: true,
      ensureLinkedProject: "interactive-vercel-link",
      deps: dependencies.addChannelsDeps,
    }),
    deployProject({
      prompter,
      ensureLinkedProject: "interactive-vercel-link",
      deps: dependencies.deployProjectDeps,
    }),
  ];

  const sink: OutputSink = { write: (line) => prompter.log.message(line) };
  const result = await runInteractive(boxes, state, sink, { snapshot: snapshotSetupState });
  if (result.kind === "cancelled") {
    return;
  }
  prompter.outro(result.state.channels.length === 0 ? "No channels added." : "Channels added.");
}

export async function runChannelsAddCommand(
  logger: CliLogger,
  appRoot: string,
  args: { kind?: string; options: AddChannelCommandOptions },
  dependencies: ChannelsAddDependencies = defaultChannelsAddDependencies,
): Promise<void> {
  if (!(await isEveProject(appRoot))) {
    logger.error(NOT_AN_AGENT_MESSAGE);
    process.exitCode = 1;
    return;
  }

  try {
    const kind = args.kind === undefined ? undefined : parseChannelKind(args.kind);
    await runAddChannelsFlow(appRoot, kind, args.options, dependencies);
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export interface ListChannelsCommandOptions {
  json?: boolean;
}

export async function runChannelsListCommand(
  logger: CliLogger,
  appRoot: string,
  options: ListChannelsCommandOptions,
): Promise<void> {
  if (!(await isEveProject(appRoot))) {
    logger.error(NOT_AN_AGENT_MESSAGE);
    process.exitCode = 1;
    return;
  }

  const channels = await listAuthoredChannels(appRoot);

  if (options.json) {
    logger.log(JSON.stringify({ channels }, null, 2));
    return;
  }

  if (channels.length === 0) {
    logger.log("No channels defined. Run `eve channels add` to add one.");
    return;
  }

  for (const name of channels) {
    logger.log(name);
  }
}
