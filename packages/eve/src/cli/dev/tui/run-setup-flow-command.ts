import { toErrorMessage } from "#shared/errors.js";

import type { PromptCommandOutcome } from "./runner.js";
import type { TuiSetupCommandInput } from "./setup-commands.js";
import type { SetupFlowRenderer } from "./setup-flow.js";

export async function runSetupFlowCommand(
  flow: SetupFlowRenderer,
  input: Omit<TuiSetupCommandInput, "renderer">,
  settle?: (outcome: PromptCommandOutcome) => Promise<PromptCommandOutcome>,
): Promise<PromptCommandOutcome> {
  let setupCommands: typeof import("./setup-commands.js");
  try {
    setupCommands = await import("./setup-commands.js");
  } catch (error) {
    return { message: `/${input.command} failed: ${toErrorMessage(error)}`, failed: true };
  }
  if (input.signal?.aborted === true) return { cancelled: true };
  flow.begin("");
  let preserveDiagnostics = true;
  try {
    const result = await setupCommands.runTuiSetupCommand({ ...input, renderer: flow });
    preserveDiagnostics = result.preserveFlowDiagnostics;
    const { preserveFlowDiagnostics: _preserve, partial: _partial, ...outcome } = result;
    return settle === undefined ? outcome : await settle(outcome);
  } finally {
    flow.end({ preserveDiagnostics });
  }
}
