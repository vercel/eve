import { HumanActionRequiredError } from "#setup/human-action.js";
import { runDeployFlow } from "#setup/flows/deploy.js";
import {
  runInstallVercelCliFlow,
  type InstallVercelCliResult,
} from "#setup/flows/install-vercel-cli.js";
import { runLoginFlow, type LoginFlowResult } from "#setup/flows/login.js";
import { runModelFlow, type ModelProviderOutcome } from "#setup/flows/model.js";
import { runProviderFlow, type ProviderPicker } from "#setup/flows/provider.js";
import { RegistryFlowFailedError, runRegistryFlow } from "#setup/flows/registry.js";
import type { Prompter } from "#setup/prompter.js";
import { WizardCancelledError } from "#setup/step.js";

import { createTuiPrompter, type TuiPrompterRenderer } from "./tui-prompter.js";
import type { PromptCommandExtensionName } from "./prompt-commands.js";
import type { SetupFlowIndicator, SetupFlowRenderer } from "./setup-flow.js";
import type { VercelStatusEffect } from "./vercel-status.js";

export type TuiSetupCommand = PromptCommandExtensionName;

/**
 * Panel title and loading indicator per command. The bordered panel never
 * repeats the echoed command verbatim, but it keeps a constant title as flows
 * move past their opening question.
 */
export const SETUP_FLOW_CONFIG = {
  "vc:install": { title: "Install the Vercel CLI", indicator: "pulse" },
  "vc:login": { title: "Log in to Vercel", indicator: "pulse" },
  model: { title: "Configure the agent model", indicator: "pulse" },
  add: { title: "Add to your agent", indicator: "pulse" },
  deploy: { title: "Deploy to Vercel", indicator: "spinner" },
} satisfies Record<TuiSetupCommand, { title: string; indicator: SetupFlowIndicator }>;

/** The prompter surface plus the working-state interrupt trap a command races against. */
export type TuiSetupCommandRenderer = TuiPrompterRenderer &
  Pick<SetupFlowRenderer, "readProviderPicker" | "readModelEditor" | "waitForInterrupt">;

type MuteableSetupRenderer = TuiPrompterRenderer &
  Pick<SetupFlowRenderer, "readProviderPicker" | "readModelEditor">;

export interface TuiSetupCommandInput {
  command: TuiSetupCommand;
  /** The local project the in-process dev server is running. */
  appRoot: string;
  /** The renderer surface the TUI-native prompter drives. */
  renderer: TuiSetupCommandRenderer;
  /** Initial model-flow step authorized by the runner's boot evidence. */
  initialModelStep?: "provider";
  /** Suspends development runtime artifacts while registry installation and setup mutate them. */
  withExclusiveTerminal?<T>(task: () => Promise<T>): Promise<T>;
  /** Test seam; defaults to the real TUI-native prompter over `renderer`. */
  createPrompter?: (renderer: TuiPrompterRenderer) => Prompter;
  /** Test seam; defaults to the real setup flows. */
  flows?: Partial<TuiSetupFlows>;
}

/** The flow entry points the commands dispatch to, injectable for tests. */
export interface TuiSetupFlows {
  runInstallVercelCliFlow: typeof runInstallVercelCliFlow;
  runLoginFlow: typeof runLoginFlow;
  runModelFlow: typeof runModelFlow;
  runRegistryFlow: typeof runRegistryFlow;
  runDeployFlow: typeof runDeployFlow;
}

function joinedTitles(titles: readonly string[]): string {
  if (titles.length === 0) return "";
  if (titles.length === 1) return titles[0]!;
  if (titles.length === 2) return `${titles[0]} and ${titles[1]}`;
  return `${titles.slice(0, -1).join(", ")}, and ${titles.at(-1)}`;
}

function registryResultMessage(
  result: Extract<Awaited<ReturnType<typeof runRegistryFlow>>, { kind: "done" }>,
): string {
  const lines = [`Added ${joinedTitles(result.items.map((item) => item.title))}`];
  for (const item of result.items) {
    if (item.facts.length === 0 && item.output.length === 0) continue;
    lines.push("", item.title);
    const width = Math.max(0, ...item.facts.map((fact) => fact.label.length));
    for (const fact of item.facts) lines.push(`  ${fact.label.padEnd(width)}  ${fact.value}`);
    for (const output of item.output) lines.push(`  ${output}`);
  }
  return lines.join("\n");
}

export interface TuiSetupCommandResult {
  message: string;
  /** Promotes an outcome to a top-level status. */
  tone?: "success" | "error";
  /** Keep warning/error lines after the bordered panel closes. */
  preserveFlowDiagnostics: boolean;
  /** Status refresh required after the command settles. */
  effect?: VercelStatusEffect | { kind: "model-access-changed" };
}

/**
 * After an interrupt starts cancellation, later renderer calls must neither
 * paint over the working state nor hang: prompts resolve as cancelled and
 * output drops while the flow unwinds.
 */
function muteableRenderer(
  renderer: TuiSetupCommandRenderer,
  isMuted: () => boolean,
  withSuspendedRuntime?: TuiSetupCommandInput["withExclusiveTerminal"],
): MuteableSetupRenderer {
  return {
    readSelect: (options) =>
      isMuted() ? Promise.resolve(undefined) : renderer.readSelect(options),
    readEditableSelect: (options) =>
      isMuted() ? Promise.resolve(undefined) : renderer.readEditableSelect(options),
    readProviderPicker: (options) =>
      isMuted() ? Promise.resolve(undefined) : renderer.readProviderPicker(options),
    readModelEditor: (options) =>
      isMuted() ? Promise.resolve(undefined) : renderer.readModelEditor(options),
    readText: (options) => (isMuted() ? Promise.resolve(undefined) : renderer.readText(options)),
    readAcknowledge: (options) =>
      isMuted() ? Promise.resolve() : renderer.readAcknowledge(options),
    readChoice: (options) =>
      isMuted()
        ? { choice: Promise.resolve(undefined), close: () => {} }
        : renderer.readChoice(options),
    setStatus: (text) => {
      if (!isMuted()) renderer.setStatus(text);
    },
    renderLine: (text, tone) => {
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
  const renderer = muteableRenderer(input.renderer, () => interrupted, input.withExclusiveTerminal);
  const prompter = (input.createPrompter ?? createTuiPrompter)(renderer);

  const interrupt = input.renderer.waitForInterrupt();
  const INTERRUPTED = Symbol("interrupted");
  const execution = executeSetupCommand(input, prompter, renderer, controller.signal);
  try {
    const outcome = await Promise.race([execution, interrupt.promise.then(() => INTERRUPTED)]);
    if (outcome !== INTERRUPTED) return outcome as TuiSetupCommandResult;
    interrupted = true;
    controller.abort(new WizardCancelledError());
    const settled = await execution;
    return {
      ...settled,
      message: `/${command} interrupted.`,
      tone: "error",
      preserveFlowDiagnostics: true,
    };
  } finally {
    interrupt.dispose();
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
): Promise<TuiSetupCommandResult> {
  const { command, appRoot } = input;
  const flows: TuiSetupFlows = {
    runInstallVercelCliFlow,
    runLoginFlow,
    runModelFlow,
    runRegistryFlow,
    runDeployFlow,
    ...input.flows,
  };

  try {
    switch (command) {
      case "vc:install": {
        return installVercelCliResultMessage(
          await flows.runInstallVercelCliFlow({ appRoot, prompter, signal }),
        );
      }
      case "vc:login": {
        return loginResultMessage(await flows.runLoginFlow({ appRoot, prompter, signal }));
      }
      case "model": {
        const pickProvider: ProviderPicker = (request) => renderer.readProviderPicker(request);
        const modelInput: Parameters<TuiSetupFlows["runModelFlow"]>[0] = {
          appRoot,
          prompter,
          signal,
          deps: {
            pickModelSettings: (request) => renderer.readModelEditor(request),
            runProviderFlow: (providerInput) =>
              runProviderFlow({ ...providerInput, picker: pickProvider }),
          },
        };
        if (input.initialModelStep !== undefined) {
          modelInput.initialStep = input.initialModelStep;
        }
        const result = await flows.runModelFlow(modelInput);
        if (result.kind === "cancelled") {
          return {
            message:
              result.discardedDraft === true
                ? "/model dismissed. Drafted changes were discarded; Done commits them."
                : "/model dismissed.",
            preserveFlowDiagnostics: false,
          };
        }
        // One line per completed menu action: the apply line (it already
        // distinguishes success from a rejected slug), then the provider
        // outcome when that sub-flow also ran.
        const lines: string[] = [];
        if (result.modelMessage !== undefined) lines.push(result.modelMessage);
        if (result.providerOutcome !== undefined) {
          lines.push(providerOutcomeMessage(result.providerOutcome));
        }
        const outcome: TuiSetupCommandResult = {
          message: lines.join("\n"),
          preserveFlowDiagnostics: false,
        };
        // Provider setup can change both the local env and Vercel identity.
        // The runner refreshes the complete model-access view after the flow.
        if (result.providerOutcome !== undefined) {
          outcome.effect = { kind: "model-access-changed" };
        }
        return outcome;
      }
      case "add": {
        const result = await flows.runRegistryFlow({ appRoot, prompter, signal });
        if (result.kind === "cancelled") {
          return { message: "/add dismissed.", preserveFlowDiagnostics: true };
        }
        if (result.addedItems.length > 0) {
          return {
            message: registryResultMessage(result),
            tone: "success",
            preserveFlowDiagnostics: true,
          };
        }
        return { message: "No registry items added.", preserveFlowDiagnostics: true };
      }
      case "deploy": {
        const result = await flows.runDeployFlow({ appRoot, prompter, interactive: true, signal });
        if (result.kind === "cancelled") {
          return { message: "/deploy dismissed.", preserveFlowDiagnostics: true };
        }
        if (result.kind === "needs-link") {
          return {
            message: "Not linked to a Vercel project — run /model to connect one first.",
            preserveFlowDiagnostics: true,
          };
        }
        return {
          message:
            result.productionUrl === undefined ? "Deployed." : `Deployed: ${result.productionUrl}`,
          preserveFlowDiagnostics: true,
          effect: { kind: "deployed" },
        };
      }
    }
  } catch (error) {
    if (error instanceof RegistryFlowFailedError) {
      const completed = error.completed;
      return {
        message: `${registryResultMessage(completed)}\n\n${error.message}`,
        tone: "error",
        preserveFlowDiagnostics: true,
      };
    }
    if (error instanceof WizardCancelledError) {
      return {
        message: `/${command} dismissed.`,
        preserveFlowDiagnostics: command !== "model",
      };
    }
    const upgrade = await vercelCliUpgradeOutcome(error, command, flows, {
      appRoot,
      prompter,
      signal,
    });
    if (upgrade !== undefined) return upgrade;
    // Provisioning steps (link, deploy, Slack) throw a Vercel human action when
    // `whoami` fails or a scope is denied. Route it to the in-TUI fix instead of
    // dumping the raw "Human action required" message.
    const routed = vercelActionOutcome(error, command);
    if (routed !== undefined) return routed;
    return {
      message: `/${command} failed: ${error instanceof Error ? error.message : String(error)}`,
      tone: "error",
      preserveFlowDiagnostics: true,
    };
  }
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
      preserveFlowDiagnostics: true,
    };
  }
  switch (result.kind) {
    case "installed":
      return {
        message: `Upgraded the Vercel CLI. Retry /${command}.`,
        preserveFlowDiagnostics: false,
      };
    case "failed":
      return {
        message: vercelCliUpgradeFailureMessage(command, result.reason),
        preserveFlowDiagnostics: true,
      };
    case "cancelled":
      return {
        message: `Vercel CLI upgrade cancelled — run \`vercel upgrade\`, then retry /${command}.`,
        preserveFlowDiagnostics: true,
      };
    case "already":
      return {
        message: `The Vercel CLI is already up to date. Retry /${command}.`,
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
  return message === undefined ? undefined : { message, preserveFlowDiagnostics: true };
}

/** The one-line fix message per Vercel action kind, or `undefined` for others. */
function vercelActionMessage(kind: string, command: string): string | undefined {
  switch (kind) {
    case "vercel-login":
      return `You're not logged in to Vercel — run /vc:login, then retry /${command}.`;
    case "vercel-forbidden":
      return `Vercel denied access to that team — run /vc:login to re-authenticate (for example to complete SSO), or pick a team you can access, then retry /${command}.`;
    case "vercel-cli-missing":
      return `The Vercel CLI isn't installed — run /vc:install to install it, then retry /${command}.`;
    case "vercel-cli-upgrade":
      return `The Vercel CLI needs an update — run \`vercel upgrade\`, then retry /${command}.`;
    default:
      return undefined;
  }
}

/** Folds an {@link InstallVercelCliResult} into the command's one-line outcome. */
function installVercelCliResultMessage(result: InstallVercelCliResult): TuiSetupCommandResult {
  switch (result.kind) {
    case "cancelled":
      return { message: "/vc:install dismissed.", preserveFlowDiagnostics: false };
    case "already":
      return { message: "The Vercel CLI is already installed.", preserveFlowDiagnostics: false };
    case "failed":
      return {
        message:
          "Couldn't install the Vercel CLI — install it manually with `npm i -g vercel@latest`.",
        preserveFlowDiagnostics: true,
      };
    case "installed":
      return {
        message: "Installed the Vercel CLI. Run /vc:login next.",
        preserveFlowDiagnostics: false,
        // The CLI now resolves, so the status line's identity probe can run.
        effect: { kind: "refresh-identity" },
      };
  }
}

/** Folds a {@link LoginFlowResult} into the command's one-line outcome. */
function loginResultMessage(result: LoginFlowResult): TuiSetupCommandResult {
  switch (result.kind) {
    case "cancelled":
      return { message: "/vc:login dismissed.", preserveFlowDiagnostics: false };
    case "already":
      return { message: "You're already logged in to Vercel.", preserveFlowDiagnostics: false };
    case "cli-missing":
      return {
        message:
          "The Vercel CLI isn't installed — run /vc:install to install it, then retry /vc:login.",
        preserveFlowDiagnostics: true,
      };
    case "failed":
      return {
        message: "Vercel login didn't complete — run /vc:login to try again.",
        preserveFlowDiagnostics: true,
      };
    case "logged-in":
      return {
        message: "Logged in to Vercel.",
        preserveFlowDiagnostics: false,
        // A now-valid `whoami` lets a previously-linked directory resolve its
        // project identity for the status line.
        effect: { kind: "refresh-identity" },
      };
    case "unavailable":
      return {
        message: "Couldn't reach Vercel — check your connection, then retry /vc:login.",
        preserveFlowDiagnostics: true,
      };
  }
}

/**
 * The persistent outcome line for /model's completed provider sub-flow. The
 * panel's success lines vanish with it, so the outcome carries the substance:
 * what the directory now reads (the same detection the menu shows) and which
 * credential is ready, or what to do next. "Project linked" is only claimed
 * when a link is actually detected — the own-key branch pastes a credential
 * without linking anything.
 */
function providerOutcomeMessage(outcome: ModelProviderOutcome): string {
  const { resolution, status } = outcome;
  if (status.kind === "gateway-project") {
    if (resolution === undefined) {
      return "Project linked. No model credential found; set AI_GATEWAY_API_KEY in .env.local.";
    }
    if (resolution.credential === "oidc") {
      return "Project linked. Connected to AI Gateway via VERCEL_OIDC_TOKEN.";
    }
    // A gateway key outranks the project's OIDC token at runtime — claiming
    // the OIDC connection while the key authenticates every call would split
    // this message from the status bar and the actual resolution.
    if (resolution.shadowedOidc !== undefined) {
      const from = resolution.source.kind === "shell" ? "shell" : resolution.source.path;
      const remove =
        resolution.source.kind === "shell"
          ? "unset it in your shell"
          : `remove it from ${resolution.source.path}`;
      return (
        `Project linked. AI_GATEWAY_API_KEY (${from}) outranks the project's ` +
        `VERCEL_OIDC_TOKEN and stays the active credential — ${remove} to run on the project.`
      );
    }
    return "Project linked. Connected to AI Gateway via AI_GATEWAY_API_KEY.";
  }
  if (status.kind === "gateway-key") {
    const where = status.source.kind === "shell" ? "your shell" : status.source.path;
    return `Connected to AI Gateway via ${status.envKey} in ${where}.`;
  }
  return "Provider updated — no gateway credential detected; set AI_GATEWAY_API_KEY in .env.local.";
}
