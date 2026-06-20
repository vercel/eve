import { join } from "node:path";

import pc from "picocolors";

import { appendEnv } from "../append-env.js";
import type { Prompter, SelectOption } from "../prompter.js";
import { WizardCancelledError } from "../step.js";
import { validateGatewayApiKey } from "../validate-gateway-key.js";
import { getVercelAuthStatus, type VercelAuthStatus } from "../vercel-project.js";

import { runLinkFlow, type LinkFlowResult } from "./link.js";

// Mirrors the private constants in boxes/apply-ai-gateway-credential.ts; the
// key name is also user-facing copy here, so the literal is the contract.
const AI_GATEWAY_ENV_KEY = "AI_GATEWAY_API_KEY";
const ENV_FILE_NAME = ".env.local";
type GatewayConnection = "project" | "own-key";

export const PROVIDER_QUESTION = "Which model provider do you want to use?";
export const CONNECTION_QUESTION = "How do you want to connect to AI Gateway?";

export const EXTERNAL_PROVIDER_INSTRUCTIONS_TITLE = "Using another model provider";
export const EXTERNAL_PROVIDER_INSTRUCTIONS: readonly string[] = [
  `Set your provider's API key in ${ENV_FILE_NAME} — e.g. ANTHROPIC_API_KEY or OPENAI_API_KEY.`,
  'In agent/agent.ts, set `model` to a provider-authored model — e.g. `anthropic("claude-opus-4.8")` from `@ai-sdk/anthropic`.',
  "See https://eve.dev/docs/agent-config for details.",
  "A running `eve dev` reloads env files automatically — no restart needed.",
];

/** Injected for tests; defaults to the real link flow, env write, and key check. */
export interface VercelFlowDeps {
  getVercelAuthStatus: typeof getVercelAuthStatus;
  runLinkFlow: typeof runLinkFlow;
  appendEnv: typeof appendEnv;
  validateGatewayApiKey: typeof validateGatewayApiKey;
}

export type VercelFlowResult =
  | LinkFlowResult
  | {
      kind: "done";
      /** The user runs a non-gateway provider; nothing was linked or written. */
      outcome: "external-provider";
    };

function projectConnectionOption(authStatus: VercelAuthStatus): SelectOption<GatewayConnection> {
  const option: SelectOption<GatewayConnection> = {
    value: "project",
    label: "Connect via a project",
    hint: "vercel link + env pull",
  };

  switch (authStatus) {
    case "authenticated":
      return option;
    case "cli-missing":
      return {
        ...option,
        disabled: true,
        disabledReason: "Vercel CLI not found, see /vc",
        disabledReasonTone: "warning",
      };
    case "logged-out":
      return {
        ...option,
        disabled: true,
        disabledReason: "Log in to Vercel first, see /login",
        disabledReasonTone: "warning",
      };
    case "unavailable":
      return {
        ...option,
        disabled: true,
        disabledReason: "Couldn't reach Vercel, check your connection",
        disabledReasonTone: "warning",
      };
    default: {
      const exhaustive: never = authStatus;
      return exhaustive;
    }
  }
}

/**
 * THE PROVIDER FLOW behind the dev TUI `/model` menu's provider row
 * (`eve link` keeps {@link runLinkFlow}'s shape). Two entry questions make
 * the provider choice explicit before any link machinery runs: a provider
 * gate (AI Gateway, or instructions for everything else) and a connection
 * gate (link a project, or paste an `AI_GATEWAY_API_KEY` that lands in
 * `.env.local`). The "Connect via a project" branch runs the link flow in
 * create-or-link mode (link detection and all), so a project-less agent can
 * create its first project rather than dead-end on an empty list.
 */
export async function runVercelFlow(input: {
  appRoot: string;
  prompter: Prompter;
  signal?: AbortSignal;
  deps?: Partial<VercelFlowDeps>;
}): Promise<VercelFlowResult> {
  const { appRoot, prompter, signal } = input;
  const deps: VercelFlowDeps = {
    getVercelAuthStatus,
    runLinkFlow,
    appendEnv,
    validateGatewayApiKey,
    ...input.deps,
  };

  let provider: "gateway" | "other";
  let connection: GatewayConnection | undefined;
  try {
    provider = await prompter.select<"gateway" | "other">({
      message: PROVIDER_QUESTION,
      options: [
        { value: "gateway", label: "Vercel AI Gateway", hint: "one key, every model" },
        { value: "other", label: "Something else", hint: "use your own provider credentials" },
      ],
      hintLayout: "stacked",
    });
    if (provider === "gateway") {
      const spinner = prompter.log.spinner?.("Checking your Vercel login…");
      let authStatus: VercelAuthStatus;
      try {
        authStatus = await deps.getVercelAuthStatus(appRoot, { signal });
        signal?.throwIfAborted();
      } finally {
        spinner?.stop();
      }

      connection = await prompter.select<GatewayConnection>({
        message: CONNECTION_QUESTION,
        options: [
          projectConnectionOption(authStatus),
          { value: "own-key", label: "Use my own key", hint: `paste an ${AI_GATEWAY_ENV_KEY}` },
        ],
        hintLayout: "stacked",
      });
    }
  } catch (error) {
    // Backing out of the entry questions keeps everything as it was — fold
    // the cancel the same way the link flow's re-link gate does.
    if (error instanceof WizardCancelledError) {
      return { kind: "cancelled" };
    }
    throw error;
  }

  if (provider === "other") {
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
    return { kind: "done", outcome: "external-provider" };
  }

  if (connection === "own-key") {
    // Loop so a rejected key returns to the same prompt to retry (or Esc to
    // cancel), rather than saving a key we know the gateway won't accept.
    while (true) {
      let key: string;
      try {
        key = await prompter.password({
          message: `Enter your ${AI_GATEWAY_ENV_KEY}`,
          validate: (value) => (value.trim().length === 0 ? "API key cannot be empty." : undefined),
        });
      } catch (error) {
        if (error instanceof WizardCancelledError) {
          return { kind: "cancelled" };
        }
        throw error;
      }
      signal?.throwIfAborted();

      const trimmed = key.trim();
      const spinner = prompter.log.spinner?.("Validating…");
      let validation: Awaited<ReturnType<typeof validateGatewayApiKey>>;
      try {
        validation = await deps.validateGatewayApiKey(trimmed, signal);
      } finally {
        spinner?.stop();
      }
      signal?.throwIfAborted();

      if (validation.kind === "invalid") {
        prompter.log.error(`${validation.message} Check the key and try again, or Esc to cancel.`);
        continue;
      }
      if (validation.kind === "inconclusive") {
        prompter.log.warning(
          `Couldn't reach the gateway to validate (${validation.message}). Saving the key anyway.`,
        );
      } else {
        prompter.log.success(`${pc.green("✓")} ${pc.bold("Valid key")}`);
      }

      await deps.appendEnv(
        join(appRoot, ENV_FILE_NAME),
        { [AI_GATEWAY_ENV_KEY]: trimmed },
        {
          force: true,
        },
      );
      signal?.throwIfAborted();
      prompter.log.success(`Saved ${AI_GATEWAY_ENV_KEY} to ${ENV_FILE_NAME}.`);
      return { kind: "done", credential: AI_GATEWAY_ENV_KEY };
    }
  } else {
    // A fresh agent often has no Vercel project yet, so this branch can create
    // one — unlike `eve link`, which links an existing project.
    return await deps.runLinkFlow({
      appRoot,
      prompter,
      signal,
      projectSelection: "create-or-link",
    });
  }
}
