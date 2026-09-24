import type { ModelAccessChange, ModelConnectionSelection } from "#shared/model-connection.js";
import { runModelLogin } from "#setup/flows/model-login.js";
import { LOGIN_CONNECTION_OPTIONS } from "#setup/flows/model-login-options.js";
import { HumanActionRequiredError } from "#setup/human-action.js";
import { runDeployFlow } from "#setup/flows/deploy.js";
import {
  runInstallVercelCliFlow,
  type InstallVercelCliResult,
} from "#setup/flows/install-vercel-cli.js";

import { RegistryFlowFailedError, runRegistryFlow } from "#setup/flows/registry.js";
import type { Prompter } from "#setup/prompter.js";
import { WizardCancelledError } from "#setup/step.js";

import type { RegistrySessionResult } from "#setup/flows/registry-session.js";

import { registryCommandOutcome, registryItemProgress } from "./registry-result-message.js";
import { createTuiPrompter, type TuiPrompterRenderer } from "./tui-prompter.js";
import type { PromptCommandExtensionName } from "./prompt-commands.js";
import type { SetupFlowRenderer } from "./setup-flow.js";
import type { VercelStatusEffect } from "./vercel-status.js";

export type TuiSetupCommand = Exclude<PromptCommandExtensionName, "model">;

/**
 * Panel title per command. The bordered panel never repeats the echoed command
 * verbatim, but it keeps a constant title as flows move past their opening
 * question.
 */
export const SETUP_FLOW_CONFIG = {
  login: { title: "" },
  add: { title: "" },
  deploy: { title: "" },
} satisfies Record<TuiSetupCommand, { title: string }>;

export type TuiSetupCommandRenderer = TuiPrompterRenderer &
  Pick<SetupFlowRenderer, "readProviderPicker" | "setNavigation" | "waitForInterrupt">;

type MuteableSetupRenderer = TuiPrompterRenderer &
  Pick<SetupFlowRenderer, "readProviderPicker" | "setNavigation">;

export type OnboardingScreenEvent = {
  screen:
    | "model_provider"
    | "model_settings"
    | "registry_channels"
    | "registry_integrations"
    | "registry_review"
    | "registry_install";
  registrySelectedCount?: number;
};

export interface TuiSetupCommandInput {
  command: TuiSetupCommand;
  /** Project root for setup that changes shared dependencies, links, or environment files. */
  appRoot: string;
  /** Selected agent root whose authored settings are changed by `/model`. */
  agentRoot?: string;
  /** The renderer surface the TUI-native prompter drives. */
  renderer: TuiSetupCommandRenderer;
  /** Initial model-flow step authorized by the runner's boot evidence. */
  initialModelStep?: "provider";
  /** Connection selected through `/login <connection>`. */
  initialLoginConnection?: ModelConnectionSelection;
  /** Registry address supplied by `/add <item>`, confirmed and installed directly. */
  initialRegistryAddress?: string;
  /** Presentation and navigation supplied by an enclosing setup journey. */
  onOnboardingScreen?: (input: OnboardingScreenEvent) => void;
  /** Live ChatGPT identity shown only inside model configuration UI. */
  chatGptAccountLabel?: string;
  /** Groups setup writes under one runtime update. */
  withExclusiveTerminal?<T>(task: () => Promise<T>): Promise<T>;
  createPrompter?: (renderer: TuiPrompterRenderer) => Prompter;
  /** Test seam; defaults to the real setup flows. */
  flows?: Partial<TuiSetupFlows>;
}

export interface TuiSetupFlows {
  runModelLogin?: typeof runModelLogin;
  runInstallVercelCliFlow: typeof runInstallVercelCliFlow;
  runRegistryFlow: typeof runRegistryFlow;
  runDeployFlow: typeof runDeployFlow;
}

export interface TuiSetupCommandResult {
  message: string;
  /** The user dismissed this setup step without completing it. */
  cancelled?: true;
  /** Keep settled batch results instead of replacing them with an interrupt notice. */
  partial?: true;
  /** Promotes an outcome to a top-level status. */
  tone?: "success" | "error";
  /** Replaces the echoed invocation once the command settles. */
  summary?: string;
  /** Keep warning/error lines after the bordered panel closes. */
  preserveFlowDiagnostics: boolean;
  /** Status refresh required after the command settles. */
  effect?: VercelStatusEffect | ModelAccessChange;
}

/**
 * After an interrupt starts cancellation, later renderer calls must neither
 * paint over the working state nor hang: prompts resolve as cancelled and
 * output drops while the flow unwinds.
 */
function muteableRenderer(
  renderer: TuiSetupCommandRenderer,
  isMuted: () => boolean,
  withSuspendedRuntime: TuiSetupCommandInput["withExclusiveTerminal"],
  warnings: string[],
): MuteableSetupRenderer {
  return {
    readSelect: (options) =>
      isMuted() ? Promise.resolve(undefined) : renderer.readSelect(options),
    readEditableSelect: (options) =>
      isMuted() ? Promise.resolve(undefined) : renderer.readEditableSelect(options),
    readProviderPicker: (options) =>
      isMuted() ? Promise.resolve(undefined) : renderer.readProviderPicker(options),
    readText: (options) => (isMuted() ? Promise.resolve(undefined) : renderer.readText(options)),
    readAcknowledge: (options) =>
      isMuted() ? Promise.resolve() : renderer.readAcknowledge(options),
    readChoice: (options) =>
      isMuted()
        ? { choice: Promise.resolve(undefined), close: () => {} }
        : renderer.readChoice(options),
    setNavigation: (navigation) => {
      if (!isMuted()) renderer.setNavigation?.(navigation);
    },
    setStatus: (text) => {
      if (!isMuted()) renderer.setStatus(text);
    },
    renderLine: (text, tone) => {
      if (tone === "warning") warnings.push(text);
      if (!isMuted() || tone === "warning" || tone === "error") {
        renderer.renderLine(text, tone);
      }
    },
    replaceContent: (content) => {
      if (!isMuted()) renderer.replaceContent?.(content);
    },
    renderOutput: (text) => {
      if (!isMuted()) renderer.renderOutput(text);
    },
    withInheritedStdio: (task) => renderer.withInheritedStdio(task),
    // Registry setup keeps the parent renderer attached; this capability now
    // pauses runtime artifacts without handing the terminal to the child.
    withExclusiveTerminal: (task) => withSuspendedRuntime?.(task) ?? task(),
  };
}

function cancelledSetupResult(): TuiSetupCommandResult {
  return { message: "", cancelled: true, preserveFlowDiagnostics: false };
}

/**
 * Runs one TUI setup command (/model, /add, /deploy) over the
 * shared setup flows, asking through the TUI's own bordered panel. Never throws:
 * every outcome — done, cancelled, failed — folds into the returned command
 * result. Ctrl-C or Esc on the working indicator (no question open) aborts the
 * active flow, then keeps command ownership until its subprocesses and setup
 * stack have unwound.
 */
export async function runTuiSetupCommand(
  input: TuiSetupCommandInput,
): Promise<TuiSetupCommandResult> {
  const { command } = input;
  let interrupted = false;
  const controller = new AbortController();
  // Flow warnings outlive the panel only as short notes on the `/add` outcome.
  const warnings: string[] = [];
  const renderer = muteableRenderer(
    input.renderer,
    () => interrupted,
    input.withExclusiveTerminal,
    warnings,
  );
  const prompter = (input.createPrompter ?? createTuiPrompter)(renderer);

  let cancelActiveRegistryItem: (() => void) | undefined;
  const runRegistryItem = async <T>(task: (signal?: AbortSignal) => Promise<T>): Promise<T> => {
    const itemController = new AbortController();
    cancelActiveRegistryItem = () => itemController.abort(new WizardCancelledError());
    try {
      return await task(AbortSignal.any([controller.signal, itemController.signal]));
    } finally {
      cancelActiveRegistryItem = undefined;
    }
  };
  // Arm the idle trap before a flow can synchronously open its first question.
  // Otherwise it replaces the question's key consumer, leaving addressed `/add`
  // confirmations visible but unresponsive.
  let interrupt = input.renderer.waitForInterrupt();
  const execution = executeSetupCommand(
    input,
    prompter,
    renderer,
    controller.signal,
    runRegistryItem,
    warnings,
  );
  const outcomePromise = execution.then((value) => ({ kind: "outcome" as const, value }));
  try {
    while (true) {
      let rearm = false;
      try {
        const settled = await Promise.race([
          outcomePromise,
          interrupt.promise.then((interrupt) => ({ kind: "interrupt" as const, interrupt })),
        ]);
        if (settled.kind === "outcome") return withCommandSummary(input, settled.value);
        if (
          command === "add" &&
          settled.interrupt === "escape" &&
          cancelActiveRegistryItem !== undefined
        ) {
          cancelActiveRegistryItem();
          rearm = true;
        } else {
          interrupted = true;
          controller.abort(new WizardCancelledError());
          const outcome = await execution;
          return withCommandSummary(
            input,
            outcome.partial === true
              ? outcome
              : { ...outcome, ...cancelledSetupResult(), tone: undefined, summary: undefined },
          );
        }
      } finally {
        interrupt.dispose();
      }
      if (rearm) interrupt = input.renderer.waitForInterrupt();
    }
  } finally {
    // A flow that threw or was abandoned mid-wait must not leave the footer spinning.
    input.renderer.setStatus(undefined);
  }
}

/** The per-command dispatch; every outcome folds into a result (never throws). */
async function executeSetupCommand(
  input: TuiSetupCommandInput,
  prompter: Prompter,
  renderer: MuteableSetupRenderer,
  signal: AbortSignal,
  runRegistryItem: <T>(task: (signal?: AbortSignal) => Promise<T>) => Promise<T>,
  warnings: readonly string[],
): Promise<TuiSetupCommandResult> {
  const { command, appRoot } = input;
  const flows: TuiSetupFlows = {
    runInstallVercelCliFlow,
    runRegistryFlow,
    runDeployFlow,
    ...input.flows,
  };

  try {
    switch (command) {
      case "login": {
        const result = await (flows.runModelLogin ?? runModelLogin)({
          appRoot,
          agentRoot: input.agentRoot,
          prompter,
          signal,
          automatic: input.initialModelStep === "provider",
          selected: input.initialLoginConnection,
          connectionMessage: "",
          withConnectionUpdate: input.withExclusiveTerminal,
        });
        if (result.kind === "cancelled") {
          return {
            // Onboarding has no echoed `/login` to summarize, so it keeps the hint.
            message:
              input.initialModelStep === "provider"
                ? "Connect a model with /login when you’re ready."
                : "",
            cancelled: true,
            preserveFlowDiagnostics: false,
          };
        }
        const connection = LOGIN_CONNECTION_OPTIONS.find(
          (option) => option.value === input.initialLoginConnection,
        );
        return {
          message: "",
          summary: connection === undefined ? "Connected" : `Connected with ${connection.label}`,
          tone: "success",
          effect: {
            kind: "model-access-changed",
            reload: result.reload,
            ...(result.model && { model: result.model }),
          },
          preserveFlowDiagnostics: false,
        };
      }
      case "add": {
        const flow = await flows.runRegistryFlow({
          appRoot,
          installRoot: input.agentRoot,
          prompter,
          signal,
          initialAddress: input.initialRegistryAddress,
          onScreen: input.onOnboardingScreen,
          onItemStart: registryItemProgress(renderer),
          runItem: runRegistryItem,
        });
        if (flow.kind === "cancelled" || flow.result.outcomes.length === 0) {
          return cancelledSetupResult();
        }
        const outcome = registryResult(flow.result, warnings);
        if (flow.result.cancelled === true) outcome.partial = true;
        if (flow.result.deployed === "production") outcome.effect = { kind: "deployed" };
        return outcome;
      }
      case "deploy": {
        const result = await flows.runDeployFlow({ appRoot, prompter, interactive: true, signal });
        if (result.kind === "cancelled") {
          return cancelledSetupResult();
        }
        if (result.kind === "needs-link") {
          return {
            message:
              "Not linked to a Vercel project. Run eve deploy in an interactive terminal to link it.",
            tone: "error",
            preserveFlowDiagnostics: true,
          };
        }
        if (result.kind === "local-model") {
          return {
            message:
              "ChatGPT subscription models are local-only. Switch to an AI Gateway or server-authenticated model before deploying.",
            tone: "error",
            preserveFlowDiagnostics: true,
          };
        }
        return {
          message: "",
          summary:
            result.productionUrl === undefined ? "Deployed" : `Deployed to ${result.productionUrl}`,
          tone: "success",
          preserveFlowDiagnostics: true,
          effect: { kind: "deployed" },
        };
      }
    }
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      return cancelledSetupResult();
    }
    const actionableError = error instanceof RegistryFlowFailedError ? error.cause : error;
    const upgrade = await vercelCliUpgradeOutcome(actionableError, command, flows, {
      appRoot,
      prompter,
      signal,
    });
    if (upgrade !== undefined) return withRegistryResults(upgrade, error, warnings);
    // Provisioning steps (link, deploy, Slack) throw a Vercel human action when
    // `whoami` fails or a scope is denied. Route it to the in-TUI fix instead of
    // dumping the raw "Human action required" message.
    const routed = vercelActionOutcome(actionableError, command);
    if (routed !== undefined) return withRegistryResults(routed, error, warnings);
    if (error instanceof RegistryFlowFailedError) {
      return withRegistryResults(
        { message: error.message, tone: "error", preserveFlowDiagnostics: false },
        error,
        warnings,
      );
    }
    return {
      message: error instanceof Error ? error.message : String(error),
      tone: "error",
      preserveFlowDiagnostics: command !== "add",
    };
  }
}

function fallbackSummaries(
  input: TuiSetupCommandInput,
): { error: string; cancelled: string } | undefined {
  switch (input.command) {
    case "add": {
      const address = input.initialRegistryAddress;
      if (address === undefined) return undefined;
      return { error: `Couldn't add ${address}`, cancelled: `${address} not added` };
    }
    case "login":
      return { error: "Couldn't connect a model", cancelled: "Login cancelled" };
    case "deploy":
      return { error: "Couldn't deploy", cancelled: "Deploy cancelled" };
  }
}

/** Failed and cancelled outcomes leave a summary in place of their invocation too. */
function withCommandSummary(
  input: TuiSetupCommandInput,
  outcome: TuiSetupCommandResult,
): TuiSetupCommandResult {
  const summaries = fallbackSummaries(input);
  if (outcome.summary !== undefined || summaries === undefined) return outcome;
  if (outcome.tone === "error") return { ...outcome, summary: summaries.error };
  if (outcome.cancelled === true) return { ...outcome, summary: summaries.cancelled };
  return outcome;
}

function registryResult(
  result: RegistrySessionResult,
  warnings: readonly string[],
): TuiSetupCommandResult {
  const { status, summary, message } = registryCommandOutcome(result, warnings);
  const outcome: TuiSetupCommandResult = { message, summary, preserveFlowDiagnostics: false };
  if (status === "neutral") {
    if (result.cancelled === true || result.outcomes.some((item) => item.kind === "cancelled"))
      outcome.cancelled = true;
  } else outcome.tone = status;
  return outcome;
}

function withRegistryResults(
  outcome: TuiSetupCommandResult,
  error: unknown,
  warnings: readonly string[],
): TuiSetupCommandResult {
  if (!(error instanceof RegistryFlowFailedError)) return outcome;
  const completed = registryResult(error.completed, warnings);
  return {
    ...outcome,
    summary: completed.summary,
    message: [completed.message, outcome.message].filter((part) => part !== "").join("\n"),
    partial: true,
    tone: "error",
    preserveFlowDiagnostics: false,
  };
}

/**
 * Offers to upgrade an old Vercel CLI when setup reports an unsupported
 * capability. This prompt is intentionally at the TUI boundary: shared setup
 * callers retain the structured human action, while an interactive command can
 * perform the recovery in place after the user opts in.
 */
async function vercelCliUpgradeOutcome(
  error: unknown,
  command: string,
  flows: TuiSetupFlows,
  input: { appRoot: string; prompter: Prompter; signal: AbortSignal },
): Promise<TuiSetupCommandResult | undefined> {
  if (!(error instanceof HumanActionRequiredError) || error.action.kind !== "vercel-cli-upgrade") {
    return undefined;
  }

  let choice: "upgrade" | "later";
  try {
    choice = await input.prompter.select({
      message: "Your Vercel CLI needs an update to list your teams. Upgrade now?",
      options: [
        {
          value: "upgrade",
          label: "Upgrade Vercel CLI",
          description: "Run the Vercel CLI's native upgrader",
        },
        { value: "later", label: "Not now" },
      ],
      initialValue: "upgrade",
    });
  } catch {
    choice = "later";
  }

  if (choice === "later") {
    return {
      message: `The Vercel CLI needs an update — run \`vercel upgrade\`, then retry /${command}.`,
      tone: "error",
      preserveFlowDiagnostics: true,
    };
  }

  let result: InstallVercelCliResult;
  try {
    result = await flows.runInstallVercelCliFlow({
      appRoot: input.appRoot,
      prompter: input.prompter,
      signal: input.signal,
      upgrade: true,
    });
  } catch (error) {
    return {
      message: vercelCliUpgradeFailureMessage(command, errorMessage(error)),
      tone: "error",
      preserveFlowDiagnostics: true,
    };
  }
  switch (result.kind) {
    case "installed":
      return {
        message: `Upgraded the Vercel CLI. Retry /${command}.`,
        tone: "error",
        preserveFlowDiagnostics: false,
      };
    case "failed":
      return {
        message: vercelCliUpgradeFailureMessage(command, result.reason),
        tone: "error",
        preserveFlowDiagnostics: true,
      };
    case "cancelled":
      return {
        message: `Vercel CLI upgrade cancelled — run \`vercel upgrade\`, then retry /${command}.`,
        tone: "error",
        preserveFlowDiagnostics: true,
      };
    case "already":
      return {
        message: `The Vercel CLI is already up to date. Retry /${command}.`,
        tone: "error",
        preserveFlowDiagnostics: false,
      };
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const compact = message.replace(/\s+/gu, " ").trim();
  return compact.length <= 240 ? compact : `${compact.slice(0, 239)}…`;
}

function vercelCliUpgradeFailureMessage(command: string, reason?: string): string {
  const detail = reason === undefined || reason === "" ? "" : ` (${reason})`;
  return `Couldn't upgrade the Vercel CLI${detail} — run \`vercel upgrade\`, then retry /${command}.`;
}

/**
 * Translates a Vercel {@link HumanActionRequiredError} into the in-TUI routing
 * message, or `undefined` for anything else. One translator so every path that
 * can surface a provisioning action, routing login, forbidden-scope, and CLI
 * recovery actions the same way rather than
 * leaking the raw error text.
 */
function vercelActionOutcome(error: unknown, command: string): TuiSetupCommandResult | undefined {
  if (!(error instanceof HumanActionRequiredError)) return undefined;
  const message = vercelActionMessage(error.action.kind, command);
  return message === undefined
    ? undefined
    : { message, tone: "error", preserveFlowDiagnostics: true };
}

/** The one-line fix message per Vercel action kind, or `undefined` for others. */
function vercelActionMessage(kind: string, command: string): string | undefined {
  switch (kind) {
    case "vercel-login":
      return `You're not logged in to Vercel — run /deploy to connect your Vercel account, then retry /${command}.`;
    case "vercel-forbidden":
      return `Vercel denied access to that team — check your team access and SSO, then retry /${command}.`;
    case "vercel-cli-missing":
      return `The Vercel CLI isn't installed — run /deploy to install it, then retry /${command}.`;
    case "vercel-cli-upgrade":
      return `The Vercel CLI needs an update — run \`vercel upgrade\`, then retry /${command}.`;
    default:
      return undefined;
  }
}
