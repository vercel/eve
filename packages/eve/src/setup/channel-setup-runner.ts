import { addChannels } from "./boxes/add-channels.js";
import type { ChannelSetupContext, ChannelSetupResult } from "./channel-setup-integration.js";
import { runInteractive } from "./runner.js";
import { snapshotSetupState, type SetupState } from "./state.js";
import type { OutputSink } from "./step.js";

/** Runs the shared scaffold box with decisions supplied by a channel integration. */
export async function runChannelSetup(
  context: ChannelSetupContext,
  options: {
    configureVercelServices?: boolean;
    slackCredentials?: "vercel-connect" | "environment";
    ensureLinkedProject?: "interactive-vercel-link";
  },
): Promise<ChannelSetupResult> {
  const box = addChannels({
    asker: context.ui.asker,
    prompter: context.ui.prompter,
    headless: context.headless,
    presetCreateSlackbot: context.presetCreateSlackbot,
    force: context.force,
    configureVercelServices: options.configureVercelServices,
    slackCredentials: options.slackCredentials,
    ensureLinkedProject: options.ensureLinkedProject,
    skipDependencyMutation: context.skipDependencyMutation,
    deps: context.deps,
  });
  const sink: OutputSink = { write: (line) => context.ui.prompter.log.message(line) };
  const result = await runInteractive([box], context.state as SetupState, sink, {
    snapshot: snapshotSetupState,
    signal: context.signal,
  });
  return result.kind === "done" ? { kind: "done", state: result.state } : { kind: "cancelled" };
}
