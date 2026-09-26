import { AI_GATEWAY_MODELS_URL, vercelGatewayFetch } from "#internal/gateway.js";
import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";
import {
  parseGatewayModelCatalog,
  type GatewayCatalogModel,
} from "#shared/gateway-model-catalog.js";

import type { SelectOption } from "../ask.js";

const FETCH_TIMEOUT_MS = 5000;
const WEB_SEARCH_TAG = "web-search";

export type { GatewayCatalogModel } from "#shared/gateway-model-catalog.js";

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
  modelOption(DEFAULT_AGENT_MODEL_ID, "Grok 4.7", "SpaceXAI"),
  modelOption("anthropic/claude-opus-4.8", "Claude Opus 4.8", "Anthropic"),
  modelOption("openai/gpt-5.5", "GPT-5.5", "OpenAI"),
  modelOption("google/gemini-3.5", "Gemini 3.5", "Google", false),
];

// Brand capitalizations first-letter uppercasing cannot produce.
const PROVIDER_BRANDS: Record<string, string> = {
  openai: "OpenAI",
  zai: "Z.AI",
  xai: "xAI",
  spacexai: "SpaceXAI",
  deepseek: "DeepSeek",
  moonshotai: "Moonshot AI",
};

function providerLabel(provider: string): string {
  if (provider.length === 0) return "";
  return PROVIDER_BRANDS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** Fetches the raw AI Gateway catalog. */
export async function fetchGatewayCatalog(signal?: AbortSignal): Promise<GatewayCatalogModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const requestSignal =
      signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
    const res = await vercelGatewayFetch(AI_GATEWAY_MODELS_URL, { signal: requestSignal });
    if (!res.ok) throw new Error(`AI Gateway model catalog request failed (${res.status}).`);
    return parseGatewayModelCatalog(await res.json());
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
 * Builds picker options from a fetched catalog, keeping the default model and
 * filtering the rest to language models with the `web-search` tag. The curated
 * shortlist comes first in its own order, followed by the rest newest-first.
 * Catalog entries on the shortlist are marked `featured`, so a searchable
 * picker opens on just them and scrolling or filtering reaches the rest. Falls
 * back to a static shortlist when the catalog is missing or yields nothing.
 */
export function modelOptionsFromCatalog(
  catalog: readonly GatewayCatalogModel[] | undefined,
): SelectOption<string>[] {
  if (catalog === undefined) return FALLBACK_MODELS;

  const models = catalog
    .filter(
      (m) =>
        m.type === "language" &&
        (m.id === DEFAULT_AGENT_MODEL_ID || (m.tags ?? []).includes(WEB_SEARCH_TAG)),
    )
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
