import { availableHelperModels } from "#internal/model-auth/available-models.js";
import type { ModelHelper } from "#shared/model-helper.js";
import { MODEL_HELPERS } from "#shared/model-helper.js";
import { inspectApplication } from "#services/inspect-application.js";
import type { ProviderSelection } from "#setup/provider-settings.js";
import type { AgentModelSettingsPatch } from "#source-change/apply-agent-model-settings.js";

import {
  fetchGatewayCatalog,
  modelOptionsFromCatalog,
  type SelectModelDeps,
} from "../boxes/select-model.js";
import {
  gatewayModelCapabilities,
  type GatewayModelCapabilities,
  type ReasoningLevel,
} from "../boxes/model-capabilities.js";
import type { AgentReasoningDefinition, ModelRouting } from "#shared/agent-definition.js";
import {
  readGatewayServiceTier,
  type GatewayServiceTierState,
} from "#shared/gateway-service-tier.js";
import type { Prompter, SelectOption } from "../prompter.js";
import { withSpinner } from "../with-spinner.js";
import {
  changeAgentModelSettings,
  formatApplyModelSettingsOutcome,
  type ApplyModelSettingsOutcome,
} from "./model-source-change.js";

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
 * A completed model or setting selection. Each field is present only when it differs from
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
}

export type ModelFlowResult =
  | {
      kind: "cancelled";
      /** Whether an incomplete selection was discarded. */
      discardedDraft?: boolean;
    }
  | {
      kind: "done";
      /** Whether authored source, auth, or Gateway selection committed. */
      accessChanged: boolean;
      /** The last apply line, when the model was changed this session. */
      modelMessage?: string;
      /** The provider selected in a completed provider sub-flow. */
      providerSelection?: ProviderSelection;
    };

/** Selects a model or setting and applies the completed edit immediately. */
export async function runModelFlow(input: {
  /** Selected agent root whose authored model settings are edited. */
  appRoot: string;
  /** Project root for shared provider configuration and Vercel credentials. */
  environmentRoot?: string;
  prompter: Prompter;
  /** Opens provider setup before the root menu when runtime evidence requires it. */
  initialStep?: "provider";
  onScreen?: (screen: "model_provider" | "model_settings") => void;
  signal?: AbortSignal;
  /** Live ChatGPT identity shown in this configuration flow only. */
  chatGptAccountLabel?: string;
  deps?: Partial<ModelFlowDeps>;
}): Promise<ModelFlowResult> {
  const { appRoot, prompter, signal } = input;
  const deps: ModelFlowDeps = {
    readCurrentModel: readCurrentAgentModel,
    applySettings: changeAgentModelSettings,
    ...input.deps,
  };

  const [currentModel, catalog] = await withSpinner(prompter, "Loading models…", () =>
    Promise.all([
      deps.readCurrentModel(appRoot),
      (deps.selectModel?.fetchModels ?? fetchGatewayCatalog)(signal).catch(() => undefined),
    ]),
  );
  const helper = Object.entries(MODEL_HELPERS).find(
    ([, spec]) =>
      currentModel.routing?.kind === "external" && currentModel.routing.provider === spec.provider,
  );
  const options = helper
    ? (await availableHelperModels(helper[0] as ModelHelper, signal)).map((id) => ({
        value: helper[1].prefix + id,
        label: id,
      }))
    : modelOptionsFromCatalog(catalog);
  if (!deps.pickModelSettings) throw new Error("The model picker is unavailable.");
  const result = await deps.pickModelSettings({
    model: currentModel.editable
      ? {
          kind: "pick",
          options,
          current:
            helper && currentModel.id
              ? helper[1].prefix + currentModel.id.replace(/^[^/]+\//u, "")
              : currentModel.id,
        }
      : {
          kind: "fixed",
          current: currentModel.id,
          reason: "This model is configured in agent.ts.",
        },
    reasoning: currentModel.reasoning === "provider-default" ? null : currentModel.reasoning,
    serviceTier: currentModel.serviceTier,
    settingsEditable: currentModel.settingsEditable,
    externalRouting: currentModel.routing?.kind === "external",
    capabilitiesFor: (id) =>
      gatewayModelCapabilities(
        catalog,
        helper && id
          ? `${helper[0] === "chatgpt" ? "openai" : helper[0]}/${id.slice(helper[1].prefix.length)}`
          : id,
      ),
  });
  if (!result) return { kind: "cancelled" };
  signal?.throwIfAborted();
  const applied = await deps.applySettings({
    appRoot,
    patch: {
      model: result.model === undefined ? { kind: "keep" } : { kind: "set", value: result.model },
      reasoning:
        result.reasoning === undefined
          ? { kind: "keep" }
          : result.reasoning === "default"
            ? { kind: "remove" }
            : { kind: "set", value: result.reasoning },
      gatewayServiceTier:
        result.serviceTier === undefined
          ? { kind: "keep" }
          : result.serviceTier === "standard"
            ? { kind: "remove" }
            : { kind: "set", value: "priority" },
    },
  });
  return {
    kind: "done",
    accessChanged: applied.kind === "changed",
    modelMessage: formatApplyModelSettingsOutcome(applied),
  };
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
    const helper = Object.values(MODEL_HELPERS).find(
      (spec) => model?.routing.kind === "external" && model.routing.provider === spec.provider,
    );
    return {
      id: helper && model !== undefined ? `${helper.prefix}${model.id}` : (model?.id ?? null),
      routing: model?.routing ?? null,
      reasoning: config?.reasoning ?? null,
      serviceTier: readGatewayServiceTier(model?.providerOptions),
      editable: model !== undefined && (model.source === undefined || helper !== undefined),
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
  if (editable) return null;
  const detail =
    routing?.kind === "external"
      ? `the external provider \`${routing.provider}\``
      : "an SDK model call";
  return `Model is set via ${detail} in agent.ts, not a string literal; /model can't rewrite it. Edit \`model\` in agent.ts.`;
}
