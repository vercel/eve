import type { ApplyModelOutcome } from "#setup/flows/model.js";
import { describeRemoteAuthCompletedMutations } from "#setup/flows/remote-auth.js";
import { WizardCancelledError } from "#setup/step.js";
import { toErrorMessage } from "#shared/errors.js";

import type {
  PromptCommandHandler,
  PromptCommandHandlerContext,
  PromptCommandOutcome,
} from "./runner.js";
import { isPromptCommandAvailableFor, type PromptCommand } from "./prompt-commands.js";
import type { RemoteConnectionController, RemoteConnectionState } from "./remote-connection.js";
import type {
  TuiSetupCommandInput,
  TuiSetupCommandTarget,
  TuiSetupFlows,
} from "./setup-commands.js";

type ExtensionCommand = Extract<PromptCommand, { type: "extension" }>;

function shouldConfigureTrustedSources(connection: RemoteConnectionState): boolean {
  switch (connection.state) {
    case "auth-required":
    case "auth-failed":
      return connection.challenge.kind === "vercel-deployment-protection";
    case "unavailable":
      return (
        connection.failure.cause === "http" &&
        connection.failure.code === "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH"
      );
    case "checking":
    case "authenticating":
    case "ready":
      return false;
  }
}

function unavailableAfterAuthentication(host: string, message: string): string {
  const [reason = message, ...details] = message.split(/\n\s*\n/u);
  const sentence = /[.!?]$/u.test(reason.trim()) ? reason.trim() : `${reason.trim()}.`;
  return [
    `Authentication was refreshed, but ${host} is unavailable: ${sentence}`,
    ...details.map((detail) => detail.trim()).filter((detail) => detail.length > 0),
  ].join("\n\n");
}

export interface PromptCommandHandlerOptions {
  readonly target: TuiSetupCommandTarget;
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
      // drift from discovery. (vc:auth's remote-only direction is enforced in
      // its own branch below.)
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
        const { appRoot } = target;
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
      const { runTuiSetupCommand, SETUP_FLOW_DESCRIPTIONS, SETUP_FLOW_TITLES } = setupCommands;
      flow.begin(SETUP_FLOW_TITLES[command.name], SETUP_FLOW_DESCRIPTIONS[command.name]);
      let preserveFlowDiagnostics = true;
      try {
        const commandInput: TuiSetupCommandInput = {
          command: command.name,
          target,
          renderer: flow,
        };
        if (options.flows !== undefined) commandInput.flows = options.flows;
        if (command.name === "vc:auth") {
          if (target.kind !== "remote" || context.remoteConnection === undefined) {
            return { message: "/vc:auth is not available in this session." };
          }
          const authCommandInput: TuiSetupCommandInput = {
            ...commandInput,
            configureTrustedSources: shouldConfigureTrustedSources(
              context.remoteConnection.current().connection,
            ),
          };
          const authenticationAbort = new AbortController();
          const interrupt = flow.waitForInterrupt();
          let authenticationInterrupted = false;
          void interrupt.promise.then(() => {
            authenticationInterrupted = true;
            authenticationAbort.abort(new WizardCancelledError());
          });
          let outcome: Awaited<ReturnType<RemoteConnectionController["authenticate"]>>;
          try {
            outcome = await context.remoteConnection.authenticate(
              context.trigger,
              async (signal) => {
                const result = await runTuiSetupCommand({
                  ...authCommandInput,
                  signal,
                  interruptMode: "external",
                });
                preserveFlowDiagnostics = result.preserveFlowDiagnostics;
                return (
                  result.remoteAuthAttempt ?? {
                    kind: "failed",
                    failure: {
                      cause: "unexpected",
                      message: result.message,
                    },
                    completedMutations: [],
                  }
                );
              },
              authenticationAbort.signal,
            );
          } finally {
            interrupt.dispose();
          }
          switch (outcome.kind) {
            case "authenticated":
              return { message: `Authenticated ${target.host} via Vercel OIDC.` };
            case "cancelled": {
              if (authenticationInterrupted) {
                const completed = describeRemoteAuthCompletedMutations(outcome.completedMutations);
                return {
                  message:
                    completed.length === 0
                      ? "/vc:auth interrupted."
                      : `/vc:auth interrupted. Completed before interruption: ${completed.join(", ")}.`,
                };
              }
              return {
                message: outcome.completedMutations.some(
                  (mutation) => mutation.kind === "vercel-login",
                )
                  ? "/vc:auth cancelled after logging in to Vercel. No project, Trusted Sources, or environment changes were made."
                  : "/vc:auth cancelled.",
              };
            }
            case "failed":
              return { message: outcome.failure.message };
            case "unavailable":
              return {
                message: unavailableAfterAuthentication(target.host, outcome.failure.message),
              };
          }
        }
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
