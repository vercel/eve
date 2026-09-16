import { WizardCancelledError } from "#setup/step.js";

import type { RemoteAuthFlow } from "./remote-auth.js";
import type { RemoteAuthCompletion, RemoteConnectionController } from "./remote-connection.js";
import type { SetupFlowRenderer } from "./setup-flow.js";
import { createTuiPrompter } from "./tui-prompter.js";

/** Offers consented deployment access repair after a remote startup challenge. */
export async function prepareRemoteTuiAccess(input: {
  connection: RemoteConnectionController;
  renderer: SetupFlowRenderer;
  signal?: AbortSignal;
  runAuthFlow?: RemoteAuthFlow;
}): Promise<RemoteAuthCompletion | undefined> {
  const { connection, renderer } = input;
  const { connection: state, target } = connection.current();
  if (
    state.state !== "auth-required" ||
    state.challenge.kind !== "vercel-deployment-protection" ||
    input.signal?.aborted
  ) {
    return;
  }

  const controller = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  renderer.begin("Deployment access");
  // Install the idle trap before the flow opens a question and takes ownership of input.
  const interrupt = renderer.waitForInterrupt();
  try {
    const execution = connection.authenticate(async (signal) => {
      const runAuthFlow = input.runAuthFlow ?? (await import("./remote-auth.js")).runRemoteAuthFlow;
      if (signal.aborted) return { kind: "cancelled", completedMutations: [] };
      return runAuthFlow({
        workspaceRoot: target.workspaceRoot,
        serverUrl: target.serverUrl,
        configureTrustedSources: true,
        prompter: createTuiPrompter(renderer),
        signal,
      });
    }, signal);
    const outcome = await Promise.race([
      execution.then((result) => ({ kind: "settled" as const, result })),
      interrupt.promise.then(() => ({ kind: "interrupted" as const })),
    ]);
    if (outcome.kind === "settled") return outcome.result;
    controller.abort(new WizardCancelledError());
    return await execution;
  } finally {
    interrupt.dispose();
    renderer.setStatus(undefined);
    renderer.end({ preserveDiagnostics: false });
  }
}
