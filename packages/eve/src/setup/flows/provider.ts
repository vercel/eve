import pc from "picocolors";

import { appendEnv } from "../append-env.js";
import {
  AI_GATEWAY_API_KEY_ENV_FILE,
  AI_GATEWAY_API_KEY_ENV_VAR,
  writeAiGatewayApiKey,
} from "../ai-gateway-api-key.js";
import type { Prompter, SelectOption } from "../prompter.js";
import { WizardCancelledError } from "../step.js";
import { validateGatewayApiKey, type GatewayKeyValidation } from "../validate-gateway-key.js";
import {
  getVercelAuthStatus,
  vercelAuthBlockerReason,
  type VercelAuthStatus,
} from "../vercel-project.js";
import { withSpinner } from "../with-spinner.js";

import { runLinkFlow, type LinkFlowResult } from "./link.js";

export type ProviderConnection = "project" | "own-key" | "external";

/**
 * How the agent's model is backed right now, as far as the local directory
 * shows: a linked Vercel project, a gateway credential in an env file, or
 * nothing detectable. An external provider (own ANTHROPIC_API_KEY etc.)
 * leaves no marker eve owns, so it reads as `unset`.
 */
export type ModelProviderStatus =
  | { kind: "unset" }
  | { kind: "gateway-project"; projectName: string; teamName?: string }
  | {
      kind: "gateway-key";
      envKey: typeof AI_GATEWAY_API_KEY_ENV_VAR | "VERCEL_OIDC_TOKEN";
      envFile: string;
    };

export const PROVIDER_QUESTION = "Which model provider do you want to use?";

export const EXTERNAL_PROVIDER_INSTRUCTIONS_TITLE = "Using another model provider";
export const EXTERNAL_PROVIDER_INSTRUCTIONS: readonly string[] = [
  `Set your provider's API key in ${AI_GATEWAY_API_KEY_ENV_FILE} — e.g. ANTHROPIC_API_KEY or OPENAI_API_KEY.`,
  'In agent/agent.ts, set `model` to a provider-authored model — e.g. `anthropic("claude-opus-4.8")` from `@ai-sdk/anthropic`.',
  "See https://eve.dev/docs/agent-config for details.",
  "A running `eve dev` reloads env files automatically — no restart needed.",
];

/** Injected for tests; defaults to the real link flow, env write, and key check. */
export interface ProviderFlowDeps {
  getVercelAuthStatus: typeof getVercelAuthStatus;
  runLinkFlow: typeof runLinkFlow;
  appendEnv: typeof appendEnv;
  validateGatewayApiKey: typeof validateGatewayApiKey;
}

export type ProviderFlowResult =
  | LinkFlowResult
  | {
      kind: "external-provider";
      /** The user runs a non-gateway provider; nothing was linked or written. */
    };

type AcceptedGatewayKeyValidation = Exclude<GatewayKeyValidation, { kind: "invalid" }>;

/** A provider choice, including the accepted evidence for an inline key. */
export type ProviderPickerChoice =
  | { kind: "project" }
  | { kind: "external" }
  | {
      kind: "inline-key";
      key: string;
      validation: AcceptedGatewayKeyValidation;
    };

/** Private Dev TUI request for the provider's one-screen chooser. */
export interface ProviderPickerRequest {
  message: string;
  options: readonly SelectOption<ProviderConnection>[];
  initialValue: ProviderConnection;
  validateInlineKey(key: string, signal: AbortSignal): Promise<GatewayKeyValidation>;
}

/** Renderer-owned provider chooser; only the Dev TUI invokes this flow. */
export type ProviderPicker = (
  request: ProviderPickerRequest,
) => Promise<ProviderPickerChoice | undefined>;

function projectConnectionOption(
  authStatus: VercelAuthStatus | undefined,
): SelectOption<ProviderConnection> {
  const option: SelectOption<ProviderConnection> = {
    value: "project",
    label: "AI Gateway via Project",
    hint: "Authenticates with AI Gateway automatically\nin a new or existing project. No keys to manage.",
  };
  const disabledReason = authStatus === undefined ? undefined : vercelAuthBlockerReason(authStatus);
  return disabledReason === undefined
    ? option
    : { ...option, disabled: true, disabledReason, disabledReasonTone: "warning" };
}

function providerOptions(
  authStatus: VercelAuthStatus | undefined,
  current: ModelProviderStatus | undefined,
): SelectOption<ProviderConnection>[] {
  let project = projectConnectionOption(authStatus);
  if (current?.kind === "gateway-project") {
    const where =
      current.teamName === undefined
        ? pc.bold(current.projectName)
        : `${pc.bold(current.projectName)} in team ${pc.bold(current.teamName)}`;
    project = { ...project, checked: true, hint: `Linked to ${where}` };
  }

  let ownKey: SelectOption<ProviderConnection> = {
    value: "own-key",
    label: `AI Gateway via ${AI_GATEWAY_API_KEY_ENV_VAR}`,
    hint: "⎿ type your key",
  };
  if (current?.kind === "gateway-key") {
    ownKey = { ...ownKey, checked: true, hint: `${current.envKey} set in ${current.envFile}` };
  }

  return [
    project,
    ownKey,
    {
      value: "external",
      label: "Other providers",
      hint: "Connect directly to a model provider\nvia OPENAI_API_KEY or ANTHROPIC_API_KEY.",
    },
  ];
}

async function selectProvider(input: {
  picker?: ProviderPicker;
  options: SelectOption<ProviderConnection>[];
  initialValue: ProviderConnection;
  validateInlineKey: (key: string, signal: AbortSignal) => Promise<GatewayKeyValidation>;
}): Promise<ProviderPickerChoice> {
  const request: ProviderPickerRequest = {
    message: PROVIDER_QUESTION,
    options: input.options,
    initialValue: input.initialValue,
    validateInlineKey: input.validateInlineKey,
  };
  if (input.picker === undefined) {
    throw new Error("The provider flow requires the Dev TUI provider picker.");
  }
  const choice = await input.picker(request);
  if (choice === undefined) throw new WizardCancelledError();
  return choice;
}

/**
 * THE PROVIDER FLOW behind the dev TUI `/model` menu's provider row
 * (`eve link` keeps {@link runLinkFlow}'s shape). One question chooses a
 * project-backed AI Gateway connection, an `AI_GATEWAY_API_KEY`, or an
 * external provider. The project branch runs the link flow in create-or-link
 * mode, so a project-less agent can create its first project rather than
 * dead-end on an empty list.
 */
export async function runProviderFlow(input: {
  appRoot: string;
  prompter: Prompter;
  signal?: AbortSignal;
  picker?: ProviderPicker;
  /** The detected provider, so the chooser can mark and describe the active row. */
  currentProvider?: ModelProviderStatus;
  deps?: Partial<ProviderFlowDeps>;
}): Promise<ProviderFlowResult> {
  const { appRoot, prompter, signal } = input;
  const deps: ProviderFlowDeps = {
    getVercelAuthStatus,
    runLinkFlow,
    appendEnv,
    validateGatewayApiKey,
    ...input.deps,
  };

  let authStatus: VercelAuthStatus | undefined;
  // The cursor opens on the active provider; a Vercel auth blocker still
  // re-homes it onto the key row below.
  let initialValue: ProviderConnection =
    input.currentProvider?.kind === "gateway-key" ? "own-key" : "project";
  let keyChoice: Extract<ProviderPickerChoice, { kind: "inline-key" }>;

  try {
    while (true) {
      const choice = await selectProvider({
        picker: input.picker,
        options: providerOptions(authStatus, input.currentProvider),
        initialValue,
        validateInlineKey: (key, validationSignal) =>
          deps.validateGatewayApiKey(
            key,
            signal === undefined ? validationSignal : AbortSignal.any([signal, validationSignal]),
          ),
      });

      if (choice.kind === "external") {
        if (prompter.acknowledge) {
          await prompter.acknowledge({
            message: EXTERNAL_PROVIDER_INSTRUCTIONS_TITLE,
            lines: EXTERNAL_PROVIDER_INSTRUCTIONS,
          });
        } else {
          prompter.note(
            EXTERNAL_PROVIDER_INSTRUCTIONS.join("\n"),
            EXTERNAL_PROVIDER_INSTRUCTIONS_TITLE,
          );
        }
        return { kind: "external-provider" };
      }

      if (choice.kind === "inline-key") {
        keyChoice = choice;
        break;
      }

      const auth = await withSpinner(prompter, "Checking your Vercel login…", () =>
        deps.getVercelAuthStatus(appRoot, { signal }),
      );
      signal?.throwIfAborted();
      authStatus = auth;
      if (vercelAuthBlockerReason(authStatus) !== undefined) {
        initialValue = "own-key";
        continue;
      }
      return await deps.runLinkFlow({
        appRoot,
        prompter,
        signal,
        projectSelection: "create-or-link",
      });
    }
  } catch (error) {
    if (error instanceof WizardCancelledError) return { kind: "cancelled" };
    throw error;
  }

  const key = keyChoice.key.trim();
  const validation = keyChoice.validation;
  signal?.throwIfAborted();

  if (validation.kind === "inconclusive") {
    prompter.log.warning(
      `Couldn't reach the gateway to validate (${validation.message}). Saving the key anyway.`,
    );
  }

  const location = await writeAiGatewayApiKey({
    projectRoot: appRoot,
    apiKey: key,
    appendEnv: deps.appendEnv,
  });
  // The env write is the commit point. A concurrent interrupt may mute the
  // remaining UI, but the caller must still refresh model access for the key
  // that is now on disk.
  prompter.log.success(`${location.envKey} set.`);
  return { kind: "done", credential: location.envKey };
}
