import { inspectApplication } from "#services/inspect-application.js";
import type {
  AgentModelSettingsPatch,
  FieldPatch,
} from "#source-change/apply-agent-model-settings.js";

import pc from "picocolors";

import { AI_GATEWAY_API_KEY_ENV_VAR } from "../ai-gateway-api-key.js";
import { interactiveAsker } from "../ask.js";
import { findEnvFileWithKey } from "../boxes/detect-ai-gateway.js";
import {
  fetchGatewayCatalog,
  selectModel,
  type SelectModelDeps,
  type SelectModelOptions,
} from "../boxes/select-model.js";
import {
  detectProjectIdentity,
  type VercelProjectOperationOptions,
} from "../project-resolution.js";
import type { AgentReasoningDefinition, ModelRouting } from "#shared/agent-definition.js";
import type { Prompter, SelectNotice, SelectOption } from "../prompter.js";
import { runInteractive } from "../runner.js";
import { snapshotSetupState } from "../state.js";
import { WizardCancelledError } from "../step.js";
import { withSpinner } from "../with-spinner.js";

import { inProjectSetupState, prompterSink } from "./in-project.js";
import {
  changeAgentModelSettings,
  formatApplyModelSettingsOutcome,
  type ApplyModelSettingsOutcome,
} from "./model-source-change.js";
import { runProviderFlow } from "./provider.js";

/** The current model id, its routing, and whether `/model` can rewrite it. */
export interface CurrentAgentModel {
  id: string | null;
  routing: ModelRouting | null;
  reasoning: AgentReasoningDefinition | null;
  serviceTier: GatewayServiceTierState;
  /**
   * The authored `model` is a string the source editor can rewrite. False for a
   * source-backed SDK model call (`gateway(...)`, `anthropic(...)`), which is
   * not a string literal — independent of how the model routes.
   */
  editable: boolean;
  /** Whether the top-level agent config object can carry reasoning/tier edits. */
  settingsEditable: boolean;
}

export type GatewayServiceTierState =
  | { kind: "standard" }
  | { kind: "priority" }
  | { kind: "custom"; value: string };

/** Injected for tests; defaults to the real reads, fetches, and source edit. */
export interface ModelFlowDeps {
  /**
   * Reads the model the runtime currently serves and how it routes; both null
   * before the first compile.
   */
  readCurrentModel: (appRoot: string) => Promise<CurrentAgentModel>;
  /** Applies one completed `/model` draft to authored source. */
  applySettings: (input: {
    appRoot: string;
    patch: AgentModelSettingsPatch;
  }) => Promise<ApplyModelSettingsOutcome>;
  /** Catalog fetch behind the shared model picker. */
  selectModel?: SelectModelDeps;
  /** Reads how the model is backed right now, for the menu's provider row. */
  detectProviderStatus: typeof detectModelProviderStatus;
  /** The provider sub-flow behind the menu's provider row. */
  runProviderFlow: typeof runProviderFlow;
}

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

/**
 * A provider sub-flow run that actually moved the provider: the credential
 * the link flow verified landed in an env file (when one did), paired with
 * the re-detected {@link ModelProviderStatus} — the same read the menu's
 * provider row shows, so every surface reports one truth. The sub-flow's
 * external-provider branch only shows instructions — nothing changes on
 * disk — so it never surfaces as an outcome.
 */
export interface ModelProviderOutcome {
  credential?: "VERCEL_OIDC_TOKEN" | typeof AI_GATEWAY_API_KEY_ENV_VAR;
  status: ModelProviderStatus;
}

export type ModelFlowResult =
  | { kind: "cancelled" }
  | {
      kind: "done";
      /** The last apply line, when the model was changed this session. */
      modelMessage?: string;
      /** The last provider sub-flow outcome, when one ran to completion. */
      providerOutcome?: ModelProviderOutcome;
    };

// The bordered panel's title ("Configure the agent model") is the menu's header,
// so the select itself carries no message — avoiding a redundant second title.
export const MODEL_MENU_MESSAGE = "";

type ModelMenuRow = "model" | "reasoning" | "fast-mode" | "provider" | "done";

type ReasoningChoice = "default" | AgentReasoningDefinition;
type FastModeChoice = "standard" | "priority";

const REASONING_OPTIONS: readonly ReasoningChoice[] = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

/**
 * The provider row's value line. `emphasis` bolds the project and team names
 * for the menu (the stacked hint line renders embedded bold safely); the
 * plain form feeds notice and outcome copy.
 */
function providerStatusHint(
  provider: Exclude<ModelProviderStatus, { kind: "unset" }>,
  emphasis: (text: string) => string = (text) => text,
): string {
  if (provider.kind === "gateway-project") {
    const where =
      provider.teamName === undefined
        ? emphasis(provider.projectName)
        : `${emphasis(provider.projectName)} in ${emphasis(provider.teamName)}`;
    return `AI Gateway (Linked to ${where})`;
  }
  return `AI Gateway (${provider.envKey} in ${provider.envFile})`;
}

/**
 * The model configuration menu. Each row owns one independently editable
 * concern; Done is the only row that commits drafted source changes.
 *
 * The model row keys off `editable`: eve can rewrite `model` only when it is a
 * string literal, so an SDK model call (`gateway(...)` / `anthropic(...)`) is
 * disabled regardless of how it routes. The provider row keys off routing: an
 * external endpoint disables it (gateway credentials don't apply); a gateway
 * endpoint gates it bold-yellow "Configure model access" until a link or credential
 * is detectable (the genuine "no provider connected" state), then "Change
 * provider" naming it.
 */
function modelMenuRows(
  current: string | null,
  reasoning: AgentReasoningDefinition | null,
  serviceTier: GatewayServiceTierState,
  provider: ModelProviderStatus,
  routing: ModelRouting | null,
  editable: boolean,
  settingsEditable: boolean,
): SelectOption<ModelMenuRow>[] {
  let modelRow: SelectOption<ModelMenuRow>;
  if (editable) {
    modelRow = {
      value: "model",
      label: "Change model",
      description: "The model your agent uses",
    };
    if (current !== null) modelRow.hint = current;
  } else {
    modelRow = {
      value: "model",
      label: "Change model",
      disabled: true,
      description: "Set via an SDK model call in agent.ts; edit the source to change it",
    };
  }

  const reasoningRow: SelectOption<ModelMenuRow> = {
    value: "reasoning",
    label: "Reasoning",
    hint: reasoning ?? "Provider default",
    description: "Effort level; exact support depends on the model and provider",
  };
  if (!settingsEditable) {
    reasoningRow.disabled = true;
    reasoningRow.description = "No editable agent.ts config object is available";
  }

  const fastModeRow: SelectOption<ModelMenuRow> = {
    value: "fast-mode",
    label: "Fast mode",
    hint:
      serviceTier.kind === "priority"
        ? "On (Gateway priority)"
        : serviceTier.kind === "standard"
          ? "Off (standard)"
          : `Custom (${serviceTier.value})`,
    description: "Requests faster Gateway processing at increased cost",
  };
  if (!settingsEditable) {
    fastModeRow.disabled = true;
    fastModeRow.description = "No editable agent.ts config object is available";
  } else if (routing?.kind === "external") {
    fastModeRow.disabled = true;
    fastModeRow.description = "Disabled for a direct external provider";
  } else if (serviceTier.kind === "custom") {
    fastModeRow.disabled = true;
    fastModeRow.description = "Custom service tier is authored in agent.ts; edit it there";
  }

  let providerRow: SelectOption<ModelMenuRow>;
  if (routing?.kind === "external") {
    providerRow = {
      disabled: true,
      value: "provider",
      label: "Change provider",
      description: "Disabled in external endpoint mode",
    };
  } else if (provider.kind === "unset") {
    providerRow = {
      value: "provider",
      label: pc.bold("Configure model access"),
      hint: pc.yellow("Not configured"),
      description: "How your agent reaches the model provider",
      accent: "warning",
    };
  } else {
    providerRow = {
      value: "provider",
      label: "Change provider",
      hint: providerStatusHint(provider, pc.bold),
      description: "How your agent reaches the model provider",
    };
  }

  // An explicit exit row, like the channels list — Esc works too, but the menu
  // must not make Esc the only way out.
  return [
    modelRow,
    reasoningRow,
    fastModeRow,
    providerRow,
    { value: "done", label: "Done", description: "Return to the prompt" },
  ];
}

/**
 * Reads the provider status the menu shows. Detection order matters: a linked
 * project subsumes any pulled credential (the link is what the user manages),
 * and `AI_GATEWAY_API_KEY` outranks `VERCEL_OIDC_TOKEN` because it is the one
 * the provider sub-flow's own-key branch writes.
 */
export async function detectModelProviderStatus(
  appRoot: string,
  options: VercelProjectOperationOptions = {},
): Promise<ModelProviderStatus> {
  const [identity, gatewayKeyFile, oidcFile] = await Promise.all([
    detectProjectIdentity(appRoot, options),
    findEnvFileWithKey(appRoot, AI_GATEWAY_API_KEY_ENV_VAR),
    findEnvFileWithKey(appRoot, "VERCEL_OIDC_TOKEN"),
  ]);
  if (identity !== undefined) {
    const status: ModelProviderStatus = {
      kind: "gateway-project",
      projectName: identity.projectName,
    };
    if (identity.teamName !== undefined) status.teamName = identity.teamName;
    return status;
  }
  if (gatewayKeyFile !== undefined) {
    return { kind: "gateway-key", envKey: AI_GATEWAY_API_KEY_ENV_VAR, envFile: gatewayKeyFile };
  }
  if (oidcFile !== undefined) {
    return { kind: "gateway-key", envKey: "VERCEL_OIDC_TOKEN", envFile: oidcFile };
  }
  return { kind: "unset" };
}

/**
 * THE MODEL FLOW for the dev TUI's `/model`: one looping configuration menu
 * for the model id, reasoning effort, Gateway priority tier, and provider.
 * Authored setting changes stay in memory until Done, then land through one
 * source transform and atomic rename.
 * The provider row runs {@link runProviderFlow}, whose single menu chooses a
 * project-backed gateway, an inline gateway key, or an external provider.
 * Model-setting changes return to the menu until Done. A completed provider
 * change commits the current draft and returns to the prompt; cancelled flows
 * and external-provider instructions return to the menu.
 */
export async function runModelFlow(input: {
  appRoot: string;
  prompter: Prompter;
  /** Opens provider setup before the root menu when runtime evidence requires it. */
  initialStep?: "provider";
  signal?: AbortSignal;
  deps?: Partial<ModelFlowDeps>;
}): Promise<ModelFlowResult> {
  const { appRoot, prompter, signal } = input;
  const deps: ModelFlowDeps = {
    readCurrentModel: readCurrentAgentModel,
    applySettings: changeAgentModelSettings,
    detectProviderStatus: detectModelProviderStatus,
    runProviderFlow,
    ...input.deps,
  };

  // The model read is local, the provider status is a `vercel` round-trip;
  // one ephemeral spinner covers both so the menu paints with no persisted
  // loading lines.
  const detectProvider = (useFlowSignal = true): Promise<ModelProviderStatus> =>
    deps.detectProviderStatus(appRoot, useFlowSignal && signal !== undefined ? { signal } : {});
  const [currentModel, initialProvider] = await withSpinner(prompter, "Checking the project…", () =>
    Promise.all([deps.readCurrentModel(appRoot), detectProvider()]),
  );
  signal?.throwIfAborted();

  let { id: current, routing, reasoning, serviceTier, editable, settingsEditable } = currentModel;
  let provider = initialProvider;
  const patch: {
    model: FieldPatch<string>;
    reasoning: FieldPatch<AgentReasoningDefinition>;
    gatewayServiceTier: FieldPatch<"priority">;
  } = {
    model: { kind: "keep" },
    reasoning: { kind: "keep" },
    gatewayServiceTier: { kind: "keep" },
  };

  let lastApply: ApplyModelSettingsOutcome | undefined;
  let providerOutcome: ModelProviderOutcome | undefined;
  let commitDraft = false;
  const externalNotice: SelectNotice | undefined =
    routing?.kind === "external"
      ? {
          tone: "warning",
          text: "`agent.ts` specifies the model provider directly. Model, provider, and Fast mode changes stay source-owned; reasoning remains configurable here.",
        }
      : undefined;

  // Start at the first useful row. Cancellation keeps the current row.
  let nextSelection: ModelMenuRow =
    provider.kind === "unset" && routing?.kind !== "external"
      ? "provider"
      : editable
        ? "model"
        : settingsEditable
          ? "reasoning"
          : "provider";
  // A gateway model with no provider cannot run. Skip the menu's extra Enter
  // and open provider setup as soon as that state is confirmed.
  let openProviderFirst =
    routing?.kind !== "external" && (input.initialStep === "provider" || provider.kind === "unset");

  while (true) {
    let pick: ModelMenuRow;
    if (openProviderFirst) {
      openProviderFirst = false;
      pick = "provider";
    } else {
      try {
        pick = await prompter.select<ModelMenuRow>({
          message: MODEL_MENU_MESSAGE,
          options: modelMenuRows(
            current,
            reasoning,
            serviceTier,
            provider,
            routing,
            editable,
            settingsEditable,
          ),
          hintLayout: "stacked",
          initialValue: nextSelection,
          notices: externalNotice === undefined ? [] : [externalNotice],
        });
      } catch (error) {
        if (!(error instanceof WizardCancelledError)) throw error;
        break;
      }
    }

    if (pick === "done") {
      commitDraft = true;
      break;
    }

    if (pick === "model") {
      const slug = await pickModelFromCatalog({
        appRoot,
        prompter,
        current,
        signal,
        deps: deps.selectModel,
      });
      if (slug === undefined) {
        nextSelection = "model";
        continue;
      }
      signal?.throwIfAborted();
      current = slug;
      routing = { kind: "gateway", target: slug.split("/")[0] ?? "" };
      patch.model = { kind: "set", value: slug };
      nextSelection = "reasoning";
      continue;
    }

    if (pick === "reasoning") {
      const selected = await pickReasoning(prompter, reasoning);
      if (selected === undefined) {
        nextSelection = "reasoning";
        continue;
      }
      reasoning = selected === "default" ? null : selected;
      patch.reasoning = reasoning === null ? { kind: "remove" } : { kind: "set", value: reasoning };
      nextSelection = "fast-mode";
      continue;
    }

    if (pick === "fast-mode") {
      const selected = await pickFastMode(prompter, serviceTier);
      if (selected === undefined) {
        nextSelection = "fast-mode";
        continue;
      }
      serviceTier = selected === "priority" ? { kind: "priority" } : { kind: "standard" };
      patch.gatewayServiceTier =
        selected === "priority" ? { kind: "set", value: "priority" } : { kind: "remove" };
      nextSelection = "done";
      continue;
    }

    const result = await deps.runProviderFlow({ appRoot, prompter, signal });
    // Backing out of the provider sub-flow changed nothing; the cursor stays on
    // the provider row so a retry is one keypress away.
    if (result.kind === "cancelled") {
      if (signal?.aborted) return { kind: "cancelled" };
      nextSelection = "provider";
      continue;
    }
    // External-provider setup only shows instructions, so keep the menu open.
    if (result.kind === "external-provider") {
      if (signal?.aborted) return { kind: "cancelled" };
      nextSelection = "done";
      continue;
    }
    // Only a completed link/own-key sub-flow can move the link or
    // credentials, so this is the one place the status is re-read. Once that
    // sub-flow commits, finish without the aborted interaction signal so the
    // TUI can refresh the state that is already on disk.
    provider = await withSpinner(prompter, "Checking the project…", () => detectProvider(false));
    providerOutcome = { status: provider };
    if (result.credential !== undefined) providerOutcome.credential = result.credential;
    commitDraft = true;
    break;
  }

  if (commitDraft && hasModelSettingsChanges(patch)) {
    lastApply = await deps.applySettings({ appRoot, patch });
    signal?.throwIfAborted();
  }

  if (lastApply === undefined && providerOutcome === undefined) {
    return { kind: "cancelled" };
  }
  const done: Extract<ModelFlowResult, { kind: "done" }> = { kind: "done" };
  if (lastApply !== undefined) done.modelMessage = formatApplyModelSettingsOutcome(lastApply);
  if (providerOutcome !== undefined) done.providerOutcome = providerOutcome;
  return done;
}

/**
 * The "Change model" sub-flow: the shared catalog picker pre-selected on
 * `current`. Resolves to the picked slug, or undefined when cancelled —
 * the menu loop treats both as "back to the menu".
 */
async function pickModelFromCatalog(input: {
  appRoot: string;
  prompter: Prompter;
  current: string | null;
  signal?: AbortSignal;
  deps?: SelectModelDeps;
}): Promise<string | undefined> {
  const { appRoot, prompter, current, signal } = input;
  const baseFetch = input.deps?.fetchModels ?? fetchGatewayCatalog;
  const options: SelectModelOptions = {
    asker: interactiveAsker(prompter),
    deps: {
      // The box fetches inside its gather, so the catalog spinner has to ride
      // the fetch itself to bracket exactly the slow part.
      fetchModels: (requestSignal) =>
        withSpinner(prompter, "Loading the model catalog...", () => baseFetch(requestSignal)),
    },
  };
  if (current !== null) options.defaultModel = current;

  const result = await runInteractive(
    [selectModel(options)],
    inProjectSetupState(appRoot, { kind: "unresolved" }),
    prompterSink(prompter),
    { snapshot: snapshotSetupState, signal },
  );
  return result.kind === "cancelled" ? undefined : result.state.modelId;
}

async function pickReasoning(
  prompter: Prompter,
  current: AgentReasoningDefinition | null,
): Promise<ReasoningChoice | undefined> {
  try {
    return await prompter.select<ReasoningChoice>({
      message: "How much reasoning should the model use?",
      options: REASONING_OPTIONS.map((value) => ({
        value,
        label: value === "default" ? "Provider default" : value,
        description:
          value === "default"
            ? "Use the selected provider's default"
            : "Availability depends on the selected model and provider",
      })),
      initialValue: current ?? "default",
    });
  } catch (error) {
    if (error instanceof WizardCancelledError) return undefined;
    throw error;
  }
}

async function pickFastMode(
  prompter: Prompter,
  current: GatewayServiceTierState,
): Promise<FastModeChoice | undefined> {
  try {
    return await prompter.select<FastModeChoice>({
      message: "Which processing mode should AI Gateway request?",
      options: [
        {
          value: "standard",
          label: "Standard",
          description: "Standard processing and pricing",
        },
        {
          value: "priority",
          label: "Fast",
          description: "Faster processing at increased cost; best effort",
        },
      ],
      initialValue: current.kind === "priority" ? "priority" : "standard",
    });
  } catch (error) {
    if (error instanceof WizardCancelledError) return undefined;
    throw error;
  }
}

function hasModelSettingsChanges(patch: AgentModelSettingsPatch): boolean {
  return (
    patch.model.kind !== "keep" ||
    patch.reasoning.kind !== "keep" ||
    patch.gatewayServiceTier.kind !== "keep"
  );
}

/**
 * Reads the model the runtime is currently serving. That's the compiled
 * `config.model.id`, the same field `eve info` reports. Returns null when the
 * app hasn't compiled yet.
 */
async function readCurrentAgentModel(appRoot: string): Promise<CurrentAgentModel> {
  try {
    const { compiledState } = await inspectApplication(appRoot);
    const config = compiledState?.manifest.config;
    const model = config?.model;
    // A source-backed model (an SDK model call) carries `source`; a string id
    // does not, and only a string is a literal the editor can rewrite.
    return {
      id: model?.id ?? null,
      routing: model?.routing ?? null,
      reasoning: config?.reasoning ?? null,
      serviceTier: readGatewayServiceTier(model?.providerOptions),
      editable: model !== undefined && model.source === undefined,
      settingsEditable: config?.source !== undefined,
    };
  } catch {
    return {
      id: null,
      routing: null,
      reasoning: null,
      serviceTier: { kind: "standard" },
      editable: false,
      settingsEditable: false,
    };
  }
}

function readGatewayServiceTier(
  providerOptions: Record<string, unknown> | undefined,
): GatewayServiceTierState {
  const gateway = providerOptions?.gateway;
  if (gateway === null || typeof gateway !== "object" || Array.isArray(gateway)) {
    return { kind: "standard" };
  }
  const value = (gateway as Record<string, unknown>).serviceTier;
  if (typeof value !== "string") return { kind: "standard" };
  return value === "priority" ? { kind: "priority" } : { kind: "custom", value };
}

/**
 * Refusal message when `/model` can't rewrite the model — it is a source-backed
 * SDK model call (`gateway(...)`, `anthropic(...)`), not a string literal — or
 * null when the model is an editable string. Editability is independent of
 * routing: a `gateway(...)` call is gateway-routed yet still uneditable here.
 */
export async function modelChangeRefusalForUneditableModel(
  appRoot: string,
): Promise<string | null> {
  const { editable, routing } = await readCurrentAgentModel(appRoot);
  if (editable) {
    return null;
  }
  const detail =
    routing?.kind === "external"
      ? `the external provider \`${routing.provider}\``
      : "an SDK model call";
  return `Model is set via ${detail} in agent.ts, not a string literal; /model can't rewrite it. Edit \`model\` in agent.ts.`;
}
