import type { ApplyModelOutcome } from "#setup/flows/model-source-change.js";
import {
  LOGIN_CONNECTION_COMMAND_HINT,
  loginConnectionForCommand,
} from "#setup/flows/model-login-options.js";
import type { AgentReasoningDefinition } from "#shared/agent-definition.js";
import { toErrorMessage } from "#shared/errors.js";

import type {
  PromptCommandHandler,
  PromptCommandHandlerContext,
  PromptCommandOutcome,
} from "./runner.js";
import { isPromptCommandAvailableFor, type PromptCommand } from "./prompt-commands.js";
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

      // Model selection is owned by the inline command drawer. Once the
      // drawer submits, this is the command's single apply path.
      if (command.name === "model") {
        if (command.argument.length === 0) {
          return { message: "Choose a model from the inline /model suggestions." };
        }
        if (target.kind !== "local") {
          return {
            message:
              "/model needs eve dev running the local server (it is not available with --url).",
          };
        }
        const appRoot = target.agentRoot ?? target.workspaceRoot;
        const usage = modelFailure(
          "Use `/model provider/model [default|none|minimal|low|medium|high|xhigh]`.",
        );
        // Package-loading failures are command outcomes at this CLI boundary.
        try {
          const { modelChangeRefusalForUneditableModel } = await import("#setup/flows/model.js");
          const { changeAgentModel, changeAgentModelSettings } =
            await import("#setup/flows/model-source-change.js");
          const [slug, reasoning, ...extra] = command.argument.split(/\s+/u);
          if (slug === undefined || extra.length > 0) return usage;
          if (
            reasoning !== undefined &&
            !["default", "none", "minimal", "low", "medium", "high", "xhigh"].includes(reasoning)
          ) {
            return usage;
          }
          // A source-backed model (an SDK model call) isn't a string literal eve
          // can rewrite; refuse with a clear reason rather than silently no-op.
          const checkRefusal = options.modelChangeRefusal ?? modelChangeRefusalForUneditableModel;
          const refusal = await checkRefusal(appRoot);
          if (refusal !== null) return modelFailure(refusal);
          const requested = reasoning === undefined ? slug : `${slug} ${reasoning}`;
          if (reasoning !== undefined) {
            const outcome = await changeAgentModelSettings({
              appRoot,
              patch: {
                model: { kind: "set", value: slug },
                reasoning:
                  reasoning === "default"
                    ? { kind: "remove" }
                    : { kind: "set", value: reasoning as AgentReasoningDefinition },
                gatewayServiceTier: { kind: "keep" },
              },
            });
            if (outcome.kind === "rejected") return modelFailure(outcome.message);
            return outcome.kind === "unchanged"
              ? { message: "", summary: `Model already set to ${requested}` }
              : { message: "", summary: `Model set to ${requested}` };
          }
          const applyModel = options.applyModel ?? changeAgentModel;
          const outcome = await applyModel({ appRoot, slug });
          if (outcome.kind === "rejected") return modelFailure(outcome.message);
          return outcome.kind === "unchanged"
            ? { message: "", summary: `Model already set to ${outcome.model}` }
            : { message: "", summary: `Model set to ${outcome.to}` };
        } catch (error) {
          return modelFailure(toErrorMessage(error));
        }
      }

      if (command.name === "add" && command.argument.length === 0) {
        return { message: "Choose an integration from the inline /add suggestions." };
      }

      const loginConnection =
        command.name === "login" && command.argument.length > 0
          ? loginConnectionForCommand(command.argument)
          : undefined;
      if (
        command.name === "login" &&
        command.argument.length > 0 &&
        loginConnection === undefined
      ) {
        return {
          message: `Use \`/login ${LOGIN_CONNECTION_COMMAND_HINT}\`.`,
        };
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
      const { runTuiSetupCommand } = setupCommands;
      flow.begin("");
      let preserveFlowDiagnostics = true;
      try {
        const commandInput: TuiSetupCommandInput = {
          command: command.name,
          appRoot: target.workspaceRoot,
          renderer: flow,
          withExclusiveTerminal: context.withExclusiveTerminal,
          chatGptAccountLabel: context.chatGptAccountLabel,
        };
        if (target.agentRoot !== undefined) commandInput.agentRoot = target.agentRoot;
        if (context.initialModelStep !== undefined) {
          commandInput.initialModelStep = context.initialModelStep;
        }
        if (context.onOnboardingScreen !== undefined) {
          commandInput.onOnboardingScreen = context.onOnboardingScreen;
        }
        if (command.name === "add") commandInput.initialRegistryAddress = command.argument;
        if (loginConnection !== undefined) commandInput.initialLoginConnection = loginConnection;
        if (options.flows !== undefined) commandInput.flows = options.flows;
        const result = await runTuiSetupCommand(commandInput);
        preserveFlowDiagnostics = result.preserveFlowDiagnostics;
        const { preserveFlowDiagnostics: _preserve, partial: _partial, ...outcome } = result;
        if (context.settleOutcome !== undefined) return await context.settleOutcome(outcome);
        return outcome;
      } finally {
        flow.end({ preserveDiagnostics: preserveFlowDiagnostics });
      }
    },
  };
}

function modelFailure(message: string): PromptCommandOutcome {
  return { message, summary: "Couldn't change the model", failed: true };
}
