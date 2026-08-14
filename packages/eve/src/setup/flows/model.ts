import {
  hasEnvValue,
  type GatewayCredentialResolution,
} from "#internal/resolve-model-endpoint-status.js";

import { inspectApplication } from "#services/inspect-application.js";
import {
  readGatewayCredentialPreference,
  writeGatewayCredentialPreference,
  type GatewayCredentialPreference,
} from "#setup/gateway-credential-preference.js";
import {
  resolveSelectedModelProvider,
  resolveSelectedModelProviderStatus,
  type ModelProviderState,
  type SelectedGatewayProvider,
  type SelectedModelProvider,
  type SelectedModelProviderStatus,
} from "#setup/model-provider-state.js";
import type {
  AgentModelSettingsPatch,
  FieldPatch,
} from "#source-change/apply-agent-model-settings.js";

import pc from "picocolors";

import { AI_GATEWAY_API_KEY_ENV_VAR } from "../ai-gateway-api-key.js";
import { findEnvFileWithKey } from "../boxes/detect-ai-gateway.js";
import {
  fetchGatewayCatalog,
  modelOptionsFromCatalog,
  type GatewayCatalogModel,
  type SelectModelDeps,
} from "../boxes/select-model.js";
import {
  gatewayModelCapabilities,
  type GatewayModelCapabilities,
  type ReasoningLevel,
} from "../boxes/model-capabilities.js";
import {
  detectProjectIdentity,
  type VercelProjectOperationOptions,
} from "../project-resolution.js";
import type { AgentReasoningDefinition, ModelRouting } from "#shared/agent-definition.js";
import {
  DEFAULT_CHATGPT_MODEL_SELECTION,
  parseChatGptModelSelection,
} from "#shared/chatgpt-model.js";
import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";
import {
  readGatewayServiceTier,
  type GatewayServiceTierState,
} from "#shared/gateway-service-tier.js";
import { formatModelSummary } from "#shared/model-summary.js";
import type { Prompter, SelectNotice, SelectOption } from "../prompter.js";
import { WizardCancelledError } from "../step.js";
import { withSpinner } from "../with-spinner.js";
import {
  changeAgentModelSettings,
  formatApplyModelSettingsOutcome,
  type ApplyModelSettingsOutcome,
} from "./model-source-change.js";
import { ensureChatGptAuth } from "./chatgpt-auth.js";
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

export type { GatewayServiceTierState };

/**
 * Everything the composite Change-model screen edits, resolved before it
 * opens. The model section is a searchable catalog pick, or a fixed line when
 * the authored model is a source-backed SDK call `/model` cannot rewrite.
 */
export interface ModelSettingsRequest {
  model:
    | { kind: "pick"; options: readonly SelectOption<string>[]; current: string | null }
    | { kind: "fixed"; current: string | null; reason: string };
  /** Authored reasoning effort; null means the provider default. */
  reasoning: ReasoningLevel | null;
  /** Authored Gateway service tier. */
  serviceTier: GatewayServiceTierState;
  /** Whether the agent config object can carry reasoning/tier edits. */
  settingsEditable: boolean;
  /** True for a direct external provider, where Gateway tiers do not apply. */
  externalRouting: boolean;
  /** Capability lookup over the already-fetched catalog; called on every pick. */
  capabilitiesFor(modelId: string | null): GatewayModelCapabilities | undefined;
}

/**
 * The screen's draft on Done. Each field is present only when it differs from
 * the authored value; `"default"` and `"standard"` mean "remove the setting".
 */
export interface ModelSettingsResult {
  model?: string;
  reasoning?: "default" | ReasoningLevel;
  serviceTier?: "standard" | "priority";
}

/** Renderer-owned composite model screen; only the dev TUI implements this. */
export type ModelSettingsPicker = (
  request: ModelSettingsRequest,
) => Promise<ModelSettingsResult | undefined>;

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
  /** The composite Change-model screen; the dev TUI renderer implements it. */
  pickModelSettings?: ModelSettingsPicker;
  /** Reads all available providers independently from persisted selection. */
  readProviderState: typeof readModelProviderState;
  /** The provider sub-flow behind the menu's provider row. */
  runProviderFlow: typeof runProviderFlow;
  /** Ensures Codex owns a usable login before selecting ChatGPT. */
  ensureChatGptAuth: typeof ensureChatGptAuth;
  writeGatewayCredentialPreference: typeof writeGatewayCredentialPreference;
}

export type ModelProviderStatus = SelectedModelProviderStatus;

/**
 * A provider sub-flow run that actually moved the provider: the credential
 * the link flow verified landed in an env file (when one did), paired with
 * the re-detected {@link ModelProviderStatus} — the same read the menu's
 * provider row shows, so every surface reports one truth. The sub-flow's
 * external-provider branch only shows instructions — nothing changes on
 * disk — so it never surfaces as an outcome.
 */
export interface ModelProviderOutcome {
  /** The credential resolution observed while setup completed. */
  resolution?: GatewayCredentialResolution;
  /** The explicit provider choice that the runtime will honor after reload. */
  selected: SelectedGatewayProvider;
  status: ModelProviderStatus;
}

export type ModelFlowResult =
  | {
      kind: "cancelled";
      /** True when Esc dropped drafted setting changes that Done would commit. */
      discardedDraft?: boolean;
    }
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

type ModelMenuRow = "model" | "provider" | "done";

/**
 * The provider row's value line. `emphasis` bolds the project and team names
 * for the menu (the stacked hint line renders embedded bold safely); the
 * plain form feeds notice and outcome copy.
 */
function providerStatusHint(
  selected: SelectedModelProvider,
  provider: ModelProviderStatus,
  chatGptAccountLabel: string | undefined,
  emphasis: (text: string) => string = (text) => text,
): string {
  if (selected === "chatgpt") {
    return chatGptAccountLabel === undefined
      ? "ChatGPT subscription"
      : `ChatGPT subscription (${chatGptAccountLabel})`;
  }
  if (selected === "gateway-project") {
    if (provider.kind !== "gateway-project" || provider.projectName === undefined) {
      return "AI Gateway via Project";
    }
    const where =
      provider.teamName === undefined
        ? emphasis(provider.projectName)
        : `${emphasis(provider.projectName)} in ${emphasis(provider.teamName)}`;
    return `AI Gateway (Linked to ${where})`;
  }
  if (provider.kind !== "gateway-key") return `AI Gateway via ${AI_GATEWAY_API_KEY_ENV_VAR}`;
  const where = provider.source.kind === "shell" ? "your shell" : provider.source.path;
  return `AI Gateway (${provider.envKey} in ${where})`;
}

/**
 * The composite screen's catalog rows: the ids themselves as labels, so the
 * railed list shows slugs and the editor's filter matches exactly what the
 * painter windows. Onboarding keeps the name-labeled options.
 */
function modelListRows(
  catalog: readonly GatewayCatalogModel[] | undefined,
): SelectOption<string>[] {
  return modelOptionsFromCatalog(catalog).map((option) => {
    const row: SelectOption<string> = { value: option.value, label: option.value };
    if (option.featured === true) row.featured = true;
    return row;
  });
}

/**
 * The Change model row's value line: the drafted slug plus its reasoning level
 * and Fast mode marker, mirroring the status line's model segment
 * (`xai/grok-4.5@high ↯`).
 */
function formatModelDraftHint(
  model: string,
  reasoning: ReasoningLevel | null,
  serviceTier: GatewayServiceTierState,
): string {
  const summary: Parameters<typeof formatModelSummary>[0] = { model };
  if (reasoning !== null) summary.reasoning = reasoning;
  if (serviceTier.kind === "priority") summary.fastGlyph = "↯";
  return formatModelSummary(summary);
}

/**
 * The model configuration menu. The Change model row opens the composite
 * screen owning the model id, reasoning effort, and service tier; Done is the
 * only row that commits drafted source changes.
 *
 * The model row stays enabled while either the model string or the config
 * object is rewritable — for an SDK model call (`gateway(...)`,
 * `anthropic(...)`) the composite opens with the model fixed and only the
 * settings adjustable. The provider row keys off routing: an external endpoint
 * disables it (gateway credentials don't apply); a gateway endpoint gates it
 * bold-yellow "Configure model access" until a link or credential is
 * detectable (the genuine "no provider connected" state), then "Change
 * provider" naming it.
 */
function modelMenuRows(
  current: string | null,
  reasoning: ReasoningLevel | null,
  serviceTier: GatewayServiceTierState,
  provider: ModelProviderStatus,
  selectedProvider: SelectedModelProvider,
  chatGptAccountLabel: string | undefined,
  routing: ModelRouting | null,
  editable: boolean,
  settingsEditable: boolean,
): SelectOption<ModelMenuRow>[] {
  let modelRow: SelectOption<ModelMenuRow>;
  if (editable || settingsEditable) {
    modelRow = {
      value: "model",
      label: "Change model",
      description: editable
        ? "The model, its reasoning effort, and the Gateway service tier"
        : "Reasoning and service tier; the model itself is an SDK model call in agent.ts",
    };
    if (current !== null) {
      modelRow.hint = formatModelDraftHint(current, reasoning, serviceTier);
    }
  } else {
    modelRow = {
      value: "model",
      label: "Change model",
      disabled: true,
      description: "Set via an SDK model call in agent.ts; edit the source to change it",
    };
  }

  let providerRow: SelectOption<ModelMenuRow>;
  if (routing?.kind === "external" && routing.provider !== "codex") {
    providerRow = {
      disabled: true,
      value: "provider",
      label: "Change provider",
      description: "Disabled in external endpoint mode",
    };
  } else if (selectedProvider !== "chatgpt" && provider.kind === "unset") {
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
      hint: providerStatusHint(selectedProvider, provider, chatGptAccountLabel, pc.bold),
      description: "How your agent reaches the model provider",
    };
  }

  // An explicit exit row, like the channels list — Esc works too, but the menu
  // must not make Esc the only way out.
  return [modelRow, providerRow, { value: "done", label: "Done" }];
}

/** Reads Gateway credential availability and the user's Gateway-only preference. */
export async function readModelProviderState(
  appRoot: string,
  options: VercelProjectOperationOptions = {},
  env: Record<string, string | undefined> = process.env,
): Promise<ModelProviderState> {
  const [identity, gatewayKeyFile, oidcFile, preferredGatewayCredential] = await Promise.all([
    detectProjectIdentity(appRoot, options),
    findEnvFileWithKey(appRoot, AI_GATEWAY_API_KEY_ENV_VAR),
    findEnvFileWithKey(appRoot, "VERCEL_OIDC_TOKEN"),
    readGatewayCredentialPreference(appRoot),
  ]);
  const available: ModelProviderState["available"] = {};
  if (identity !== undefined || oidcFile !== undefined) {
    const gatewayProject: {
      projectName?: string;
      teamName?: string;
      oidcFile?: string;
    } = {};
    if (identity !== undefined) {
      gatewayProject.projectName = identity.projectName;
      gatewayProject.teamName = identity.teamName;
    }
    if (oidcFile !== undefined) gatewayProject.oidcFile = oidcFile;
    available.gatewayProject = gatewayProject;
  }
  if (gatewayKeyFile !== undefined) {
    available.gatewayKey = { source: { kind: "env-file", path: gatewayKeyFile } };
  } else if (hasEnvValue(env[AI_GATEWAY_API_KEY_ENV_VAR])) {
    available.gatewayKey = { source: { kind: "shell" } };
  }
  return { available, preferredGatewayCredential };
}

/**
 * THE MODEL FLOW for the dev TUI's `/model`: a root menu whose Change model
 * row opens the composite model screen (catalog pick, reasoning-effort slider,
 * service-tier toggle) and whose provider row runs {@link runProviderFlow}.
 * Authored setting changes stay in memory until Done, then land through one
 * source transform and atomic rename. A completed provider change commits the
 * current draft and returns to the prompt; cancelled flows and
 * external-provider instructions return to the menu.
 */
export async function runModelFlow(input: {
  appRoot: string;
  prompter: Prompter;
  /** Opens provider setup before the root menu when runtime evidence requires it. */
  initialStep?: "provider";
  signal?: AbortSignal;
  /** Gives Codex uncontested inherited stdio while it performs login. */
  withExclusiveTerminal?: <T>(task: () => Promise<T>) => Promise<T>;
  /** Live ChatGPT identity shown in this configuration flow only. */
  chatGptAccountLabel?: string;
  deps?: Partial<ModelFlowDeps>;
}): Promise<ModelFlowResult> {
  const { appRoot, prompter, signal } = input;
  const deps: ModelFlowDeps = {
    readCurrentModel: readCurrentAgentModel,
    applySettings: changeAgentModelSettings,
    readProviderState: readModelProviderState,
    runProviderFlow,
    ensureChatGptAuth,
    writeGatewayCredentialPreference,
    ...input.deps,
  };

  // The model read is local; the provider status and the catalog are round
  // trips. One ephemeral spinner covers all three so the menu paints with no
  // persisted loading lines and already knows what the model supports. A
  // failed catalog fetch degrades to unknown capabilities, never to an error.
  const readProviderState = (useFlowSignal = true): Promise<ModelProviderState> =>
    deps.readProviderState(
      appRoot,
      useFlowSignal && signal !== undefined ? { signal } : {},
      process.env,
    );
  const fetchCatalog = deps.selectModel?.fetchModels ?? fetchGatewayCatalog;
  const [currentModel, initialProviderState, catalog] = await withSpinner(
    prompter,
    "Checking the project…",
    () =>
      Promise.all([
        deps.readCurrentModel(appRoot),
        readProviderState(),
        fetchCatalog(signal).catch((): GatewayCatalogModel[] | undefined => undefined),
      ]),
  );
  signal?.throwIfAborted();

  let { id: current, routing, serviceTier, editable, settingsEditable } = currentModel;
  // An authored "provider-default" is the absent-setting sentinel, not a level.
  let reasoning: ReasoningLevel | null =
    currentModel.reasoning === "provider-default" ? null : currentModel.reasoning;
  let providerState = initialProviderState;
  let selectedProvider = resolveSelectedModelProvider(providerState, routing);
  let provider = resolveSelectedModelProviderStatus(providerState, selectedProvider);
  let nextGatewayCredentialPreference: GatewayCredentialPreference | undefined;
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
  let chatGptLoginReady = false;
  let commitDraft = false;
  const sourceOwnedExternalRouting = routing?.kind === "external" && routing.provider !== "codex";
  const externalNotice: SelectNotice | undefined = sourceOwnedExternalRouting
    ? {
        tone: "warning",
        text: "`agent.ts` specifies the model provider directly. Model, provider, and service-tier changes stay source-owned; reasoning remains configurable here.",
      }
    : undefined;

  // Start at the first useful row. Cancellation keeps the current row.
  let nextSelection: ModelMenuRow =
    provider.kind === "unset" && routing?.kind !== "external"
      ? "provider"
      : editable || settingsEditable
        ? "model"
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
            selectedProvider === "chatgpt" ? { kind: "standard" } : serviceTier,
            provider,
            selectedProvider,
            input.chatGptAccountLabel,
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
        // Esc discards the draft. Say so: before drafts existed, a completed
        // model pick applied immediately, so a silent drop reads as success.
        if (hasModelSettingsChanges(patch)) return { kind: "cancelled", discardedDraft: true };
        break;
      }
    }

    if (pick === "done") {
      commitDraft = true;
      break;
    }

    if (pick === "model") {
      const pickModelSettings = deps.pickModelSettings;
      if (pickModelSettings === undefined) {
        throw new Error("runModelFlow requires a pickModelSettings dep to open the model screen.");
      }
      const request: ModelSettingsRequest = {
        model: editable
          ? { kind: "pick", options: modelListRows(catalog), current }
          : {
              kind: "fixed",
              current,
              reason: "Set via an SDK model call in agent.ts; edit the source to change it",
            },
        reasoning,
        serviceTier: selectedProvider === "chatgpt" ? { kind: "standard" } : serviceTier,
        settingsEditable,
        externalRouting: sourceOwnedExternalRouting,
        capabilitiesFor: (modelId) => gatewayModelCapabilities(catalog, modelId),
      };
      const result = await pickModelSettings(request);
      signal?.throwIfAborted();
      if (result === undefined) {
        nextSelection = "model";
        continue;
      }
      if (result.model !== undefined) {
        current = result.model;
        routing = routingForModelSelection(result.model);
        selectedProvider = resolveSelectedModelProvider(providerState, routing);
        provider = resolveSelectedModelProviderStatus(providerState, selectedProvider);
        patch.model = { kind: "set", value: result.model };
      }
      if (result.reasoning !== undefined) {
        reasoning = result.reasoning === "default" ? null : result.reasoning;
        patch.reasoning =
          reasoning === null ? { kind: "remove" } : { kind: "set", value: reasoning };
      }
      if (result.serviceTier !== undefined && selectedProvider !== "chatgpt") {
        serviceTier =
          result.serviceTier === "priority" ? { kind: "priority" } : { kind: "standard" };
        patch.gatewayServiceTier =
          result.serviceTier === "priority"
            ? { kind: "set", value: "priority" }
            : { kind: "remove" };
      }
      nextSelection = "done";
      continue;
    }

    const result = await deps.runProviderFlow({
      appRoot,
      prompter,
      signal,
      providerState,
      selectedProvider,
    });
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
    if (result.kind === "chatgpt") {
      if (selectedProvider === "chatgpt") {
        await authenticateChatGpt(deps, input.withExclusiveTerminal);
        chatGptLoginReady = true;
      } else {
        patch.model = { kind: "set", value: DEFAULT_CHATGPT_MODEL_SELECTION };
        patch.gatewayServiceTier = { kind: "remove" };
      }
      commitDraft = true;
      break;
    }
    const switchingFromChatGpt = selectedProvider === "chatgpt";
    const gatewaySelection: SelectedGatewayProvider =
      result.kind === "project" ? "gateway-project" : "gateway-key";
    const gatewayResult = result.kind === "project" ? result.result : result;
    selectedProvider = gatewaySelection;
    if (switchingFromChatGpt) {
      patch.model = { kind: "set", value: DEFAULT_AGENT_MODEL_ID };
    }
    nextGatewayCredentialPreference =
      gatewaySelection === "gateway-project" ? "project" : "api-key";
    // Only a completed link/own-key sub-flow can move the link or
    // credentials, so this is the one place the status is re-read. Once that
    // sub-flow commits, finish without the aborted interaction signal so the
    // TUI can refresh the state that is already on disk.
    providerState = await withSpinner(prompter, "Checking the project…", () =>
      readProviderState(false),
    );
    provider = resolveSelectedModelProviderStatus(providerState, gatewaySelection);
    providerOutcome = { selected: gatewaySelection, status: provider };
    if (gatewayResult.kind === "done" && gatewayResult.resolution !== undefined) {
      providerOutcome.resolution = gatewayResult.resolution;
    }
    commitDraft = true;
    break;
  }

  if (commitDraft && hasModelSettingsChanges(patch)) {
    if (patch.model.kind === "set" && parseChatGptModelSelection(patch.model.value) !== undefined) {
      patch.gatewayServiceTier = { kind: "remove" };
      await authenticateChatGpt(deps, input.withExclusiveTerminal);
    }
    lastApply = await deps.applySettings({ appRoot, patch });
    if (lastApply.kind !== "rejected" && nextGatewayCredentialPreference !== undefined) {
      await deps.writeGatewayCredentialPreference(appRoot, nextGatewayCredentialPreference);
    }
    if (providerOutcome === undefined) signal?.throwIfAborted();
  } else if (commitDraft && nextGatewayCredentialPreference !== undefined) {
    await deps.writeGatewayCredentialPreference(appRoot, nextGatewayCredentialPreference);
  }

  if (lastApply === undefined && providerOutcome === undefined && !chatGptLoginReady) {
    return { kind: "cancelled" };
  }
  const done: Extract<ModelFlowResult, { kind: "done" }> = { kind: "done" };
  if (lastApply !== undefined) done.modelMessage = formatApplyModelSettingsOutcome(lastApply);
  else if (chatGptLoginReady) done.modelMessage = "ChatGPT login ready.";
  if (providerOutcome !== undefined) done.providerOutcome = providerOutcome;
  return done;
}

function routingForModelSelection(selection: string): ModelRouting {
  if (parseChatGptModelSelection(selection) !== undefined) {
    return { kind: "external", provider: "codex" };
  }
  return { kind: "gateway", target: selection.split("/")[0] ?? "" };
}

async function authenticateChatGpt(
  deps: ModelFlowDeps,
  withExclusiveTerminal: (<T>(task: () => Promise<T>) => Promise<T>) | undefined,
): Promise<void> {
  const authenticate = (): Promise<void> => deps.ensureChatGptAuth({ interactive: true });
  await (withExclusiveTerminal === undefined
    ? authenticate()
    : withExclusiveTerminal(authenticate));
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
    const chatgpt = model?.routing.kind === "external" && model.routing.provider === "codex";
    return {
      id: chatgpt && model !== undefined ? `chatgpt/${model.id}` : (model?.id ?? null),
      routing: model?.routing ?? null,
      reasoning: config?.reasoning ?? null,
      serviceTier: readGatewayServiceTier(model?.providerOptions),
      editable: model !== undefined && (model.source === undefined || chatgpt),
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
  if (editable || (routing?.kind === "external" && routing.provider === "codex")) {
    return null;
  }
  const detail =
    routing?.kind === "external"
      ? `the external provider \`${routing.provider}\``
      : "an SDK model call";
  return `Model is set via ${detail} in agent.ts, not a string literal; /model can't rewrite it. Edit \`model\` in agent.ts.`;
}
