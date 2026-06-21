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

type ProviderConnection = "project" | "own-key" | "external";

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

type AuthProbeResult =
  | { kind: "resolved"; status: VercelAuthStatus }
  | { kind: "rejected"; error: unknown };

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
): SelectOption<ProviderConnection>[] {
  return [
    projectConnectionOption(authStatus),
    {
      value: "own-key",
      label: `AI Gateway via ${AI_GATEWAY_API_KEY_ENV_VAR}`,
      hint: ">  type your key",
    },
    {
      value: "external",
      label: "Other providers",
      hint: "Connect directly to a model provider\nvia OPENAI_API_KEY or ANTHROPIC_API_KEY.",
    },
  ];
}

type AcceptedGatewayValidation = Exclude<GatewayKeyValidation, { kind: "invalid" }>;

type GatewayKeyChoice = {
  kind: "inline-key";
  key: string;
  validation: AcceptedGatewayValidation;
};

type ProviderChoice = Exclude<ProviderConnection, "own-key"> | GatewayKeyChoice;

async function selectProvider(input: {
  selectEditable: NonNullable<Prompter["selectEditable"]>;
  options: SelectOption<ProviderConnection>[];
  initialValue: ProviderConnection;
  validateInlineKey: (key: string, signal: AbortSignal) => Promise<GatewayKeyValidation>;
}): Promise<ProviderChoice> {
  const result = await input.selectEditable<ProviderConnection, AcceptedGatewayValidation>({
    message: PROVIDER_QUESTION,
    options: input.options,
    hintLayout: "stacked",
    initialValue: input.initialValue,
    editable: {
      value: "own-key",
      defaultValue: "",
      placeholder: "type your key",
      mask: true,
      footerHint: "type your key",
      inlineInvalidLabel: "Invalid key",
      cancelBehavior: "clear-first",
      formatHint: (value: string) => `>  ${value}`,
      validate: async (value, signal) => {
        if (value.trim().length === 0) {
          return { kind: "rejected", message: "API key cannot be empty." };
        }
        const validation = await input.validateInlineKey(value.trim(), signal);
        if (validation.kind === "invalid") {
          return {
            kind: "rejected",
            message: `${validation.message} Check the key and try again, or Esc to cancel.`,
          };
        }
        return { kind: "accepted", payload: validation };
      },
    },
  });
  if (result.kind === "submitted") {
    return {
      kind: "inline-key",
      key: result.text,
      validation: result.payload,
    };
  }
  if (result.value === "own-key") {
    throw new Error("The editable provider row returned without a submitted key.");
  }
  return result.value;
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
  deps?: Partial<ProviderFlowDeps>;
}): Promise<ProviderFlowResult> {
  const { appRoot, prompter, signal } = input;
  const { selectEditable } = prompter;
  if (selectEditable === undefined) {
    throw new Error("The provider flow requires an editable-select prompter.");
  }
  const deps: ProviderFlowDeps = {
    getVercelAuthStatus,
    runLinkFlow,
    appendEnv,
    validateGatewayApiKey,
    ...input.deps,
  };

  // Start the bounded auth check before input, but await it only if the user
  // chooses Project. Other choices stay interactive and cancel unused work.
  const authAbort = new AbortController();
  const authSignal =
    signal === undefined ? authAbort.signal : AbortSignal.any([signal, authAbort.signal]);
  const authProbe: Promise<AuthProbeResult> = deps
    .getVercelAuthStatus(appRoot, { signal: authSignal })
    .then(
      (status) => ({ kind: "resolved", status }),
      (error: unknown) => ({ kind: "rejected", error }),
    );

  let authStatus: VercelAuthStatus | undefined;
  let initialValue: ProviderConnection = "project";
  let keyChoice: GatewayKeyChoice;

  try {
    while (true) {
      const choice = await selectProvider({
        selectEditable,
        options: providerOptions(authStatus),
        initialValue,
        validateInlineKey: (key, validationSignal) =>
          deps.validateGatewayApiKey(
            key,
            signal === undefined ? validationSignal : AbortSignal.any([signal, validationSignal]),
          ),
      });

      if (choice === "external") {
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

      if (choice !== "project") {
        keyChoice = choice;
        break;
      }

      const auth = await withSpinner(prompter, "Checking your Vercel login…", async () => {
        const result = await authProbe;
        if (result.kind === "rejected") throw result.error;
        return result.status;
      });
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
  } finally {
    authAbort.abort();
  }

  const key = keyChoice.key.trim();
  const validation = keyChoice.validation;
  signal?.throwIfAborted();

  if (validation.kind === "inconclusive") {
    prompter.log.warning(
      `Couldn't reach the gateway to validate (${validation.message}). Saving the key anyway.`,
    );
  } else {
    prompter.log.success(`${pc.green("✓")} ${pc.bold("Valid key")}`);
  }

  const location = await writeAiGatewayApiKey({
    projectRoot: appRoot,
    apiKey: key,
    appendEnv: deps.appendEnv,
  });
  // The env write is the commit point. A concurrent interrupt may mute the
  // remaining UI, but the caller must still refresh model access for the key
  // that is now on disk.
  prompter.log.success(`Saved ${location.envKey} to ${location.envFile}.`);
  return { kind: "done", credential: location.envKey };
}
