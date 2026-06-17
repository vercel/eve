import type { ApplyModelOutcome } from "#setup/flows/model.js";
import { toErrorMessage } from "#shared/errors.js";

import type {
  PromptCommandHandler,
  PromptCommandHandlerContext,
  PromptCommandOutcome,
} from "./runner.js";
import type { PromptCommand } from "./prompt-commands.js";
import type { TuiSetupCommandInput, TuiSetupFlows } from "./setup-commands.js";

type ExtensionCommand = Extract<PromptCommand, { type: "extension" }>;

export interface PromptCommandHandlerOptions {
  readonly appRoot?: string;
  /** Test seam; defaults to the model flow's shared source-change apply. */
  readonly applyModel?: (input: { appRoot: string; slug: string }) => Promise<ApplyModelOutcome>;
  /** Test seam; defaults to the model flow's external-provider refusal check. */
  readonly modelChangeRefusal?: (appRoot: string) => Promise<string | null>;
  /** Test seam; forwarded to runTuiSetupCommand's injectable flows. */
  readonly flows?: Partial<TuiSetupFlows>;
}

export function createPromptCommandHandler(
  options: PromptCommandHandlerOptions,
): PromptCommandHandler {
  return {
    async handle(
      command: ExtensionCommand,
      context: PromptCommandHandlerContext,
    ): Promise<PromptCommandOutcome> {
      const appRoot = options.appRoot;
      if (appRoot === undefined) {
        return {
          message: `/${command.name} needs eve dev running the local server (it is not available with --url).`,
        };
      }

      // `/model <slug>` applies directly; only the bare command opens the
      // configure menu flow below.
      if (command.name === "model" && command.argument.length > 0) {
        // Package-loading failures are command outcomes at this CLI boundary.
        try {
          const {
            changeAgentModel,
            formatApplyModelOutcome,
            modelChangeRefusalForUneditableModel,
          } = await import("#setup/flows/model.js");
          // A source-backed model (an SDK model call) isn't a string literal eve
          // can rewrite; refuse with a clear reason rather than silently no-op.
          const checkRefusal = options.modelChangeRefusal ?? modelChangeRefusalForUneditableModel;
          const refusal = await checkRefusal(appRoot);
          if (refusal !== null) {
            return { message: refusal };
          }
          const applyModel = options.applyModel ?? changeAgentModel;
          return {
            message: formatApplyModelOutcome(await applyModel({ appRoot, slug: command.argument })),
          };
        } catch (error) {
          return {
            message: `Couldn't change the model: ${toErrorMessage(error)}`,
          };
        }
      }

      const flow = context.renderer.setupFlow;
      if (flow === undefined) {
        return { message: `/${command.name} is not supported by this renderer.` };
      }

      let setupCommands: typeof import("./setup-commands.js");
      try {
        setupCommands = await import("./setup-commands.js");
      } catch (error) {
        return { message: `/${command.name} failed: ${toErrorMessage(error)}` };
      }
      const { runTuiSetupCommand, SETUP_FLOW_TITLES } = setupCommands;
      flow.begin(SETUP_FLOW_TITLES[command.name]);
      let preserveFlowDiagnostics = true;
      try {
        const commandInput: TuiSetupCommandInput = {
          command: command.name,
          appRoot,
          renderer: flow,
        };
        if (options.flows !== undefined) commandInput.flows = options.flows;
        const result = await runTuiSetupCommand(commandInput);
        preserveFlowDiagnostics = result.preserveFlowDiagnostics;
        const outcome: PromptCommandOutcome = { message: result.message };
        if (result.vercelEffect !== undefined) outcome.vercelEffect = result.vercelEffect;
        return outcome;
      } finally {
        flow.end({ preserveDiagnostics: preserveFlowDiagnostics });
      }
    },
  };
}
