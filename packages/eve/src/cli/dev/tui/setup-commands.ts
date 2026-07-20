import { HumanActionRequiredError } from "#setup/human-action.js";
import { runChannelsFlow } from "#setup/flows/channels.js";
import { runConnectionsFlow } from "#setup/flows/connections.js";
import { runDeployFlow } from "#setup/flows/deploy.js";
import {
  runInstallVercelCliFlow,
  type InstallVercelCliResult,
} from "#setup/flows/install-vercel-cli.js";
import { runLoginFlow, type LoginFlowResult } from "#setup/flows/login.js";
import { runModelFlow, type ModelProviderOutcome } from "#setup/flows/model.js";
import { runProviderFlow, type ProviderPicker } from "#setup/flows/provider.js";
import { openUrl } from "#setup/primitives/open-url.js";
import type { Prompter } from "#setup/prompter.js";
import { slackMessageDeepLink } from "#setup/slack-connect.js";
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
  channels: { title: "Agent channels", indicator: "pulse" },
  connect: { title: "Agent connections", indicator: "pulse" },
  deploy: { title: "Deploy to Vercel", indicator: "spinner" },
} satisfies Record<TuiSetupCommand, { title: string; indicator: SetupFlowIndicator }>;

/** The prompter surface plus the working-state interrupt trap a command races against. */
export type TuiSetupCommandRenderer = TuiPrompterRenderer &
  Pick<SetupFlowRenderer, "readProviderPicker" | "waitForInterrupt">;

type MuteableSetupRenderer = TuiPrompterRenderer & Pick<SetupFlowRenderer, "readProviderPicker">;

export interface TuiSetupCommandInput {
  command: TuiSetupCommand;
  /** The local project the in-process dev server is running. */
  appRoot: string;
  /** The renderer surface the TUI-native prompter drives. */
  renderer: TuiSetupCommandRenderer;
  /** Initial model-flow step authorized by the runner's boot evidence. */
  initialModelStep?: "provider";
  disabledConnectionReasons?: Readonly<Record<string, string>>;
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
  runChannelsFlow: typeof runChannelsFlow;
  runConnectionsFlow: typeof runConnectionsFlow;
  runDeployFlow: typeof runDeployFlow;
}

export interface TuiSetupCommandResult {
  message: string;
  /** Keep warning/error lines after the bordered panel closes. */
  preserveFlowDiagnostics: boolean;
  /** Status refresh required after the command settles. */
  effect?: VercelStatusEffect | { kind: "connection-added" } | { kind: "model-access-changed" };
}

/**
 * After an interrupt starts cancellation, later renderer calls must neither
 * paint over the working state nor hang: prompts resolve as cancelled and
 * output drops while the flow unwinds.
 */
function muteableRenderer(
  renderer: TuiSetupCommandRenderer,
  isMuted: () => boolean,
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
    setStatus: (text) => {
      if (!isMuted()) renderer.setStatus(text);
    },
    renderLine: (text, tone) => {
      if (!isMuted() || tone === "warning" || tone === "error") {
        renderer.renderLine(text, tone);
      }
    },
    renderOutput: (text) => {
      if (!isMuted()) renderer.renderOutput(text);
    },
  };
}

/**
 * Runs one TUI setup command (/model, /channels, /connect, /deploy) over the
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
  const renderer = muteableRenderer(input.renderer, () => interrupted);
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
    runChannelsFlow,
    runConnectionsFlow,
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
            runProviderFlow: (providerInput) =>
              runProviderFlow({ ...providerInput, picker: pickProvider }),
          },
        };
        if (input.initialModelStep !== undefined) {
          modelInput.initialStep = input.initialModelStep;
        }
        const result = await flows.runModelFlow(modelInput);
        if (result.kind === "cancelled") {
          return { message: "/model cancelled.", preserveFlowDiagnostics: false };
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
      case "channels": {
        const result = await flows.runChannelsFlow({ appRoot, prompter, signal });
        switch (result.kind) {
          case "failed":
            // A provisioning failure (login / forbidden / missing CLI) throws
            // before any channel file lands, so it propagates to the catch below
            // and routes to its fix command; a `failed` result here is a
            // post-scaffold fault (e.g. a UID reconcile), reported as-is.
            return pendingChannelsResult(
              `Channel files changed, but /channels failed: ${result.message}`,
            );
          case "cancelled":
            return { message: "/channels cancelled.", preserveFlowDiagnostics: true };
          case "deploy-and-chat":
            return await runDeployAndChat(flows, { appRoot, prompter, signal }, result.chat);
          case "done":
            if (result.addedChannels.length === 0) {
              return { message: "No channels added.", preserveFlowDiagnostics: true };
            }
            return {
              message: `Channels added: ${result.addedChannels.join(", ")} — run /deploy to ship them.`,
              preserveFlowDiagnostics: true,
              effect: { kind: "channels-added" },
            };
        }
      }
      case "connect": {
        const result = await flows.runConnectionsFlow({
          appRoot,
          prompter,
          signal,
          disabledConnectionReasons: input.disabledConnectionReasons,
        });
        switch (result.kind) {
          case "cancelled":
            return {
              message: "/connect cancelled.",
              preserveFlowDiagnostics: true,
              effect: { kind: "model-access-changed" },
            };
          case "failed":
            return {
              message:
                result.addedConnections.length === 0
                  ? `/connect failed: ${result.message}`
                  : `Connection files changed, but /connect failed: ${result.message}`,
              preserveFlowDiagnostics: true,
              effect:
                result.addedConnections.length === 0
                  ? { kind: "model-access-changed" }
                  : { kind: "connection-added" },
            };
          case "done":
            return {
              message:
                result.addedConnections.length === 0
                  ? "No connections added."
                  : `Connections added: ${result.addedConnections.join(", ")}.`,
              preserveFlowDiagnostics: true,
              effect:
                result.addedConnections.length === 0
                  ? { kind: "model-access-changed" }
                  : { kind: "connection-added" },
            };
        }
      }
      case "deploy": {
        const result = await flows.runDeployFlow({ appRoot, prompter, interactive: true, signal });
        if (result.kind === "cancelled") {
          return { message: "/deploy cancelled.", preserveFlowDiagnostics: true };
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
    if (error instanceof WizardCancelledError) {
      return {
        message: `/${command} cancelled.`,
        preserveFlowDiagnostics: command !== "model",
      };
    }
    // Provisioning steps (link, deploy, Slack) throw a Vercel human action when
    // `whoami` fails or a scope is denied. Route it to the in-TUI fix instead of
    // dumping the raw "Human action required" message.
    const routed = vercelActionOutcome(error, command);
    if (routed !== undefined) return routed;
    return {
      message: `/${command} failed: ${error instanceof Error ? error.message : String(error)}`,
      preserveFlowDiagnostics: true,
    };
  }
}

/**
 * Translates a Vercel {@link HumanActionRequiredError} into the in-TUI routing
 * message, or `undefined` for anything else. One translator so every path that
 * can surface a provisioning action — the command catch, the `/channels`
 * partial-success result, and the deploy-and-chat continuation — routes
 * `vercel-login`, `vercel-forbidden`, and `vercel-cli-missing` the same way
 * rather than leaking the raw error text.
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
    default:
      return undefined;
  }
}

/**
 * The "Deploy and chat" continuation of /channels: deploy the freshly added
 * Slack channel, then point the user at the workspace so they can message the
 * bot. A cancelled or unlinked deploy reports exactly like /deploy and drops
 * the chat hint — there is nothing live to chat with yet.
 */
async function runDeployAndChat(
  flows: TuiSetupFlows,
  input: { appRoot: string; prompter: Prompter; signal: AbortSignal },
  chat: { chatUrl?: string; workspaceName?: string },
): Promise<TuiSetupCommandResult> {
  let result: Awaited<ReturnType<TuiSetupFlows["runDeployFlow"]>>;
  try {
    result = await flows.runDeployFlow({ ...input, interactive: true });
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      return pendingChannelsResult(
        "Channels added, but /deploy was cancelled. Run /deploy to ship them.",
      );
    }
    const routed = vercelActionOutcome(error, "deploy");
    if (routed !== undefined) return pendingChannelsResult(`Channels added. ${routed.message}`);
    const message = error instanceof Error ? error.message : String(error);
    return pendingChannelsResult(`Channels added, but /deploy failed: ${message}`);
  }
  if (result.kind === "cancelled") {
    return pendingChannelsResult(
      "Channels added, but /deploy was cancelled. Run /deploy to ship them.",
    );
  }
  if (result.kind === "needs-link") {
    return pendingChannelsResult(
      "Channels added, but this directory is not linked to Vercel. Run /model, then /deploy.",
    );
  }
  const live =
    result.productionUrl === undefined ? "Deployed." : `Deployed: ${result.productionUrl}`;
  let chatLine: string;
  if (chat.chatUrl === undefined) {
    chatLine = "Message your agent in Slack to see it live.";
  } else {
    // Open the bot's Messages tab (a DM compose) ourselves. Unlike
    // `connect create`, nothing else opens a browser at this step.
    const chatUrl = slackMessageDeepLink(chat.chatUrl);
    openUrl(chatUrl);
    chatLine = `Chat with your agent in Slack: ${chatUrl}`;
  }
  return {
    message: `${live}\n${chatLine}`,
    preserveFlowDiagnostics: true,
    effect: { kind: "deployed" },
  };
}

/** Folds an {@link InstallVercelCliResult} into the command's one-line outcome. */
function installVercelCliResultMessage(result: InstallVercelCliResult): TuiSetupCommandResult {
  switch (result.kind) {
    case "cancelled":
      return { message: "/vc:install cancelled.", preserveFlowDiagnostics: false };
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
      return { message: "/vc:login cancelled.", preserveFlowDiagnostics: false };
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

function pendingChannelsResult(message: string): TuiSetupCommandResult {
  return {
    message,
    preserveFlowDiagnostics: true,
    effect: { kind: "channels-added" },
  };
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
  const { credential, status } = outcome;
  if (status.kind === "gateway-project") {
    return credential === undefined
      ? "Project linked. No model credential found; set AI_GATEWAY_API_KEY in .env.local."
      : `Project linked. Connected to AI Gateway via ${credential}.`;
  }
  if (status.kind === "gateway-key") {
    return `Connected to AI Gateway via ${status.envKey} in ${status.envFile}.`;
  }
  return "Provider updated — no gateway credential detected; set AI_GATEWAY_API_KEY in .env.local.";
}
