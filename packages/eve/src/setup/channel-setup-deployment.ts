import type { DeployProjectDeps } from "./boxes/deploy-project.js";
import { deployProject } from "./boxes/deploy-project.js";
import type { ChannelSetupUi } from "./channel-setup-ui.js";
import { runInteractive } from "./runner.js";
import { snapshotSetupState, type SetupState } from "./state.js";
import type { OutputSink } from "./step.js";

/** Offers and, when accepted, performs deployment after channel setup completes. */
export async function deployChannelSetup(input: {
  state: SetupState;
  ui: ChannelSetupUi;
  signal?: AbortSignal;
  presetDeploy?: boolean;
  deps?: DeployProjectDeps;
}): Promise<SetupState> {
  const shouldDeploy =
    input.presetDeploy ??
    (await input.ui.confirm({
      key: "deploy-channels",
      message: "Deploy this project to Vercel now?",
      recommended: true,
    }));
  if (!shouldDeploy) {
    input.ui.nextSteps(["Run `eve deploy` to deploy when ready."]);
    return input.state;
  }

  const sink: OutputSink = { write: (line) => input.ui.prompter.log.message(line) };
  const result = await runInteractive(
    [
      deployProject({
        prompter: input.ui.prompter,
        ensureLinkedProject: "interactive-vercel-link",
        deps: input.deps,
      }),
    ],
    input.state,
    sink,
    { snapshot: snapshotSetupState, signal: input.signal },
  );
  return result.kind === "done" ? result.state : input.state;
}
