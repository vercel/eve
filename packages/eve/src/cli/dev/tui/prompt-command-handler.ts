import type { ApplyModelOutcome } from "#setup/flows/model.js";
import { toErrorMessage } from "#shared/errors.js";

import type {
  PromptCommandHandler,
  PromptCommandHandlerContext,
  PromptCommandOutcome,
} from "./runner.js";
import { isPromptCommandAvailableFor, type PromptCommand } from "./prompt-commands.js";
import type { RemoteAuthFlow } from "./remote-auth.js";
import type { TuiSetupCommandInput, TuiSetupFlows } from "./setup-commands.js";
import type { DevelopmentTuiTarget } from "./target.js";

type ExtensionCommand = Extract<PromptCommand, { type: "extension" }>;

export interface PromptCommandHandlerOptions {
  readonly target: DevelopmentTuiTarget;
  /** Test seam; defaults to the model flow's shared source-change apply. */
  readonly applyModel?: (input: { appRoot: string; slug: string }) => Promise<ApplyModelOutcome>;
  /** Test seam; defaults to the model flow's external-provider refusal check. */
  readonly modelChangeRefusal?: (appRoot: string) => Promise<string | null>;
  /** Test seam; forwarded to runTuiSetupCommand's injectable flows. */
  readonly flows?: Partial<TuiSetupFlows>;
  /** Test seam for remote authentication. */
  readonly remoteAuthFlow?: RemoteAuthFlow;
}

export function createPromptCommandHandler(
  options: PromptCommandHandlerOptions,
): PromptCommandHandler {
  return {
    async handle(
      command: ExtensionCommand,
      context: PromptCommandHandlerContext,
    ): Promise<PromptCommandOutcome> {
      const { target } = options;
      // Local-only commands invoked on a remote target are rejected here; the
      // allowlist is derived from each command's `targets` so dispatch can't
      // drift from discovery.
      if (target.kind === "remote" && !isPromptCommandAvailableFor(command.name, "remote")) {
        return {
          message: `/${command.name} needs eve dev running the local server (it is not available with --url).`,
        };
      }

      // `/model <slug>` applies directly; only the bare command opens the
      // configure menu flow below.
      if (command.name === "model" && command.argument.length > 0) {
        if (target.kind !== "local") {
          return {
            message:
              "/model needs eve dev running the local server (it is not available with --url).",
          };
        }
        const appRoot = target.workspaceRoot;
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

      if (command.name === "vc:login" && target.kind === "remote") {
        if (context.remoteConnection === undefined) {
          return { message: "/vc:login is not available in this session." };
        }
        let runRemoteAuthCommand: (typeof import("./remote-auth-command.js"))["runRemoteAuthCommand"];
        try {
          ({ runRemoteAuthCommand } = await import("./remote-auth-command.js"));
        } catch (error) {
          return { message: `/vc:login failed: ${toErrorMessage(error)}` };
        }
        const message = await runRemoteAuthCommand({
          connection: context.remoteConnection,
          flow: options.remoteAuthFlow,
          renderer: flow,
        });
        return { message };
      }

      // The remaining setup commands run against the local workspace, except
      // `/vc:install`, which needs only a working directory on a remote session.
      let setupCommands: typeof import("./setup-commands.js");
      try {
        setupCommands = await import("./setup-commands.js");
      } catch (error) {
        return { message: `/${command.name} failed: ${toErrorMessage(error)}` };
      }
      const { runTuiSetupCommand, SETUP_FLOW_CONFIG } = setupCommands;
      const flowConfig = SETUP_FLOW_CONFIG[command.name];
      flow.begin(flowConfig.title, flowConfig.indicator);
      let preserveFlowDiagnostics = true;
      try {
        const commandInput: TuiSetupCommandInput = {
          command: command.name,
          appRoot: target.workspaceRoot,
          renderer: flow,
        };
        if (context.initialModelStep !== undefined) {
          commandInput.initialModelStep = context.initialModelStep;
        }
        if (options.flows !== undefined) commandInput.flows = options.flows;
        const result = await runTuiSetupCommand(commandInput);
        preserveFlowDiagnostics = result.preserveFlowDiagnostics;
        const outcome: PromptCommandOutcome = { message: result.message };
        if (result.effect !== undefined) outcome.effect = result.effect;
        return outcome;
      } finally {
        flow.end({ preserveDiagnostics: preserveFlowDiagnostics });
      }
    },
  };
}
