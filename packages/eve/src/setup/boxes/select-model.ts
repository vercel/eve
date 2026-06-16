import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";

import { select, type Asker, type SelectOption } from "../ask.js";
import type { SetupState } from "../state.js";
import type { SetupBox } from "../step.js";

const AI_GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/models";
const FETCH_TIMEOUT_MS = 5000;
const POPULAR_PROVIDERS: readonly string[] = ["anthropic", "openai", "google"];
const WEB_SEARCH_TAG = "web-search";
const MODEL_PROMPT_MESSAGE = "Which model should your agent use?";

/** One model entry from the AI Gateway catalog response. */
export interface GatewayCatalogModel {
  id: string;
  name: string;
  type: string;
  owned_by: string;
  tags?: readonly string[];
}

function modelOption(
  value: string,
  label: string,
  hint: string,
  featured: boolean = true,
): SelectOption<string> {
  return { id: value, label, value, hint, featured: featured || undefined };
}

/**
 * Curated shortlist shown as the picker's default view; the rest of the
 * catalog is reached by scrolling past it or typing a filter. Order here is
 * display order.
 */
const FEATURED_MODEL_IDS: readonly string[] = [
  DEFAULT_AGENT_MODEL_ID,
  "anthropic/claude-opus-4.8",
  "openai/gpt-5.5",
];

const FALLBACK_MODELS: SelectOption<string>[] = [
  modelOption(DEFAULT_AGENT_MODEL_ID, "Claude Sonnet 4.6", "Anthropic"),
  modelOption("anthropic/claude-opus-4.8", "Claude Opus 4.8", "Anthropic"),
  modelOption("openai/gpt-5.5", "GPT-5.5", "OpenAI"),
  modelOption("google/gemini-3.5", "Gemini 3.5", "Google", false),
];

function providerLabel(provider: string): string {
  if (provider.length === 0) return "";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function providerPriority(provider: string): number {
  const index = POPULAR_PROVIDERS.indexOf(provider);
  return index === -1 ? POPULAR_PROVIDERS.length : index;
}

/** Fetches the raw AI Gateway catalog. The default for {@link SelectModelDeps}. */
export async function fetchGatewayCatalog(signal?: AbortSignal): Promise<GatewayCatalogModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const requestSignal =
      signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
    const res = await fetch(AI_GATEWAY_URL, { signal: requestSignal });
    const json = (await res.json()) as { data: GatewayCatalogModel[] };
    return json.data;
  } finally {
    clearTimeout(timeout);
  }
}

/** Position in the curated shortlist, or its length for everything else. */
function featuredPriority(id: string): number {
  const index = FEATURED_MODEL_IDS.indexOf(id);
  return index === -1 ? FEATURED_MODEL_IDS.length : index;
}

/**
 * Builds the picker options from the catalog (filtered to language models with
 * the `web-search` tag), with the curated shortlist first in its own order and
 * the rest sorted popular providers first. Catalog entries on the shortlist
 * are marked `featured`, so the picker opens on just them and scrolling or
 * filtering reaches the rest. Falls back to a static shortlist when the fetch
 * fails or yields nothing.
 */
async function buildModelOptions(
  fetchModels: (signal?: AbortSignal) => Promise<GatewayCatalogModel[]>,
  signal?: AbortSignal,
): Promise<SelectOption<string>[]> {
  try {
    const data = await fetchModels(signal);

    const models = data
      .filter((m) => m.type === "language" && (m.tags ?? []).includes(WEB_SEARCH_TAG))
      .map((m) => {
        const provider = m.id.split("/")[0] ?? "";
        return {
          value: m.id,
          label: m.name,
          hint: providerLabel(provider),
          provider,
        };
      })
      .sort((a, b) => {
        const featuredDiff = featuredPriority(a.value) - featuredPriority(b.value);
        if (featuredDiff !== 0) return featuredDiff;
        const priorityDiff = providerPriority(a.provider) - providerPriority(b.provider);
        if (priorityDiff !== 0) return priorityDiff;
        const providerDiff = a.provider.localeCompare(b.provider);
        if (providerDiff !== 0) return providerDiff;
        return a.label.localeCompare(b.label);
      });

    if (models.length === 0) return FALLBACK_MODELS;
    return models.map(({ value, label, hint }) => ({
      id: value,
      label,
      value,
      hint,
      featured: FEATURED_MODEL_IDS.includes(value) || undefined,
    }));
  } catch {
    signal?.throwIfAborted();
    return FALLBACK_MODELS;
  }
}

/** Injected for tests; defaults to the real AI Gateway catalog fetch. */
export interface SelectModelDeps {
  fetchModels: (signal?: AbortSignal) => Promise<GatewayCatalogModel[]>;
}

export interface SelectModelOptions {
  /** Resolves the model question; the composed stack decides how. */
  asker: Asker;
  /**
   * Resolve to this value without fetching the catalog or asking. Stays a
   * factory option (not a `withAnswers` rung) because a preset must keep
   * short-circuiting the catalog fetch and must keep accepting ids the
   * filtered catalog does not list, exactly as the dual-face box did.
   */
  presetModel?: string;
  /**
   * Pre-select this model in the picker so enter confirms it. Falls back to the
   * top catalog entry when omitted or not present in the catalog.
   */
  defaultModel?: string;
  deps?: SelectModelDeps;
}

/**
 * THE MODEL BOX: pick the default model baked into `agent/agent.ts`. The
 * gather fetches the AI Gateway catalog and asks one required "model" select
 * through the box's asker, so an interactive stack offers a searchable picker
 * while a headless stack refuses structurally when no preset answered it.
 * The model is the first thing the interview decides about the agent itself;
 * how the credential is wired (gateway vs your own provider key) is the
 * provisioning box's later decision, and the byok scaffold derives its
 * provider block from whatever model was picked here.
 */
export function selectModel(options: SelectModelOptions): SetupBox<SetupState, string, string> {
  const deps = options.deps ?? { fetchModels: fetchGatewayCatalog };

  return {
    id: "select-model",

    async gather({ signal }): Promise<string> {
      const preset = options.presetModel;
      if (preset !== undefined && preset.length > 0) return preset;
      const models = await buildModelOptions(deps.fetchModels, signal);
      const recommended =
        options.defaultModel !== undefined && models.some((m) => m.value === options.defaultModel)
          ? options.defaultModel
          : models.some((m) => m.value === DEFAULT_AGENT_MODEL_ID)
            ? DEFAULT_AGENT_MODEL_ID
            : models[0]?.value;
      return options.asker.ask(
        select({
          key: "model",
          message: MODEL_PROMPT_MESSAGE,
          options: models,
          recommended,
          // A headless run without a preset must fail rather than guess a
          // model, as the dual-face box did.
          required: true,
          search: true,
          placeholder: "type to search",
        }),
      );
    },

    async perform({ input }): Promise<string> {
      return input;
    },

    apply(state, payload) {
      return { ...state, modelId: payload };
    },
  };
}
