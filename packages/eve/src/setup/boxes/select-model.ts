import { z } from "#compiled/zod/index.js";
import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";

import { select, type Asker, type SelectOption } from "../ask.js";
import type { SetupState } from "../state.js";
import type { SetupBox } from "../step.js";

const AI_GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/models";
const FETCH_TIMEOUT_MS = 5000;
const WEB_SEARCH_TAG = "web-search";
const MODEL_PROMPT_MESSAGE = "Which model should your agent use?";

const gatewayCatalogModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  owned_by: z.string(),
  /** Public release timestamp in Unix seconds. Missing values sort last. */
  released: z.number().finite().optional().catch(undefined),
  tags: z.array(z.string()).optional().catch(undefined),
  /** Per-tier pricing; the `service_tiers` keys reveal Fast mode (priority) support. */
  pricing: z
    .object({ service_tiers: z.record(z.string(), z.unknown()).optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

const gatewayCatalogSchema = z.object({ data: z.array(z.unknown()) }).transform(({ data }) =>
  data.flatMap((entry) => {
    const result = gatewayCatalogModelSchema.safeParse(entry);
    return result.success ? [result.data] : [];
  }),
);

/** One model entry from the AI Gateway catalog response. */
export type GatewayCatalogModel = z.infer<typeof gatewayCatalogModelSchema>;

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
  modelOption(DEFAULT_AGENT_MODEL_ID, "Claude Sonnet 5", "Anthropic"),
  modelOption("anthropic/claude-opus-4.8", "Claude Opus 4.8", "Anthropic"),
  modelOption("openai/gpt-5.5", "GPT-5.5", "OpenAI"),
  modelOption("google/gemini-3.5", "Gemini 3.5", "Google", false),
];

// Brand capitalizations first-letter uppercasing cannot produce.
const PROVIDER_BRANDS: Record<string, string> = {
  openai: "OpenAI",
  xai: "xAI",
  deepseek: "DeepSeek",
  moonshotai: "Moonshot AI",
};

function providerLabel(provider: string): string {
  if (provider.length === 0) return "";
  return PROVIDER_BRANDS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** Fetches the raw AI Gateway catalog. The default for {@link SelectModelDeps}. */
export async function fetchGatewayCatalog(signal?: AbortSignal): Promise<GatewayCatalogModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const requestSignal =
      signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
    const res = await fetch(AI_GATEWAY_URL, { signal: requestSignal });
    if (!res.ok) throw new Error(`AI Gateway model catalog request failed (${res.status}).`);
    return parseGatewayCatalog(await res.json());
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Validates a Gateway catalog response. A malformed payload throws (the
 * picker then falls back to the static shortlist), but a malformed entry is
 * skipped: one experimental entry shape must not take down the whole catalog.
 */
export function parseGatewayCatalog(input: unknown): GatewayCatalogModel[] {
  const result = gatewayCatalogSchema.safeParse(input);
  if (!result.success) {
    throw new Error("AI Gateway returned an invalid model catalog.");
  }
  return result.data;
}

/** Position in the curated shortlist, or its length for everything else. */
function featuredPriority(id: string): number {
  const index = FEATURED_MODEL_IDS.indexOf(id);
  return index === -1 ? FEATURED_MODEL_IDS.length : index;
}

/**
 * Builds picker options from a fetched catalog (filtered to language models
 * with the `web-search` tag), with the curated shortlist first in its own
 * order and the rest sorted newest release first. Catalog entries on the
 * shortlist are marked `featured`, so a searchable picker opens on just them
 * and scrolling or filtering reaches the rest. Falls back to a static
 * shortlist when the catalog is missing or yields nothing.
 */
export function modelOptionsFromCatalog(
  catalog: readonly GatewayCatalogModel[] | undefined,
): SelectOption<string>[] {
  if (catalog === undefined) return FALLBACK_MODELS;

  const models = catalog
    .filter((m) => m.type === "language" && (m.tags ?? []).includes(WEB_SEARCH_TAG))
    .map((m) => {
      const provider = m.id.split("/")[0] ?? "";
      return {
        value: m.id,
        label: m.name,
        hint: providerLabel(provider),
        provider,
        released: m.released,
      };
    })
    .sort((a, b) => {
      const featuredDiff = featuredPriority(a.value) - featuredPriority(b.value);
      if (featuredDiff !== 0) return featuredDiff;
      const releasedDiff =
        (b.released ?? Number.NEGATIVE_INFINITY) - (a.released ?? Number.NEGATIVE_INFINITY);
      if (releasedDiff !== 0) return releasedDiff;
      const labelDiff = a.label.localeCompare(b.label);
      if (labelDiff !== 0) return labelDiff;
      return a.value.localeCompare(b.value);
    });

  if (models.length === 0) return FALLBACK_MODELS;
  return models.map(({ value, label, hint }) => ({
    id: value,
    label,
    value,
    hint,
    featured: FEATURED_MODEL_IDS.includes(value) || undefined,
  }));
}

async function buildModelOptions(
  fetchModels: (signal?: AbortSignal) => Promise<GatewayCatalogModel[]>,
  signal?: AbortSignal,
): Promise<SelectOption<string>[]> {
  try {
    return modelOptionsFromCatalog(await fetchModels(signal));
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
