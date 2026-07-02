import type { LanguageModel } from "ai";

const EXPERIMENTAL_CODEX_MODEL_KIND = "eve.experimental-codex-model";

const OPENAI_GATEWAY_PREFIX = "openai/";

/**
 * The model value produced by {@link experimental_codex}: an OpenAI model
 * served through the local Codex login in development, with an optional
 * deployable fallback for production builds.
 *
 * This is a compile-time routing instruction, not an AI SDK model instance.
 */
export interface ExperimentalCodexModel {
  readonly kind: typeof EXPERIMENTAL_CODEX_MODEL_KIND;
  /** Bare OpenAI model slug, e.g. `"gpt-5.5"`. */
  readonly model: string;
  /** Deployable model used when a production build cannot route `openai/<model>`. */
  readonly fallback?: LanguageModel;
}

/**
 * Narrows an authored `model` value to the {@link experimental_codex} shape.
 */
export function isExperimentalCodexModel(value: unknown): value is ExperimentalCodexModel {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("kind" in value) || value.kind !== EXPERIMENTAL_CODEX_MODEL_KIND) {
    return false;
  }
  return "model" in value && typeof value.model === "string";
}

/**
 * Experimental: serves an OpenAI model through your local Codex login
 * (`codex login`) during development.
 *
 * Assign the result to `model` in `agent.ts`. In development builds eve reads
 * Codex login state from `~/.codex/auth.json` and serves the model over the
 * Codex Responses backend. Production builds never use the local login: eve
 * optimistically routes the same model as `openai/<model>` through the AI
 * Gateway when the gateway catalog knows that id, otherwise it uses
 * `fallback` — and fails the build when no fallback is provided.
 *
 * ```ts
 * export default defineAgent({
 *   model: experimental_codex("gpt-5.5", anthropic("claude-sonnet-4.6")),
 * });
 * ```
 *
 * Unstable: this API can change or disappear in any release.
 */
export function experimental_codex(
  model: string,
  fallback?: LanguageModel,
): ExperimentalCodexModel {
  const slug = normalizeCodexModelSlug(model);
  if (fallback === undefined) {
    return { kind: EXPERIMENTAL_CODEX_MODEL_KIND, model: slug };
  }
  return { kind: EXPERIMENTAL_CODEX_MODEL_KIND, model: slug, fallback };
}

function normalizeCodexModelSlug(model: string): string {
  const trimmed = model.trim();
  const slug = trimmed.startsWith(OPENAI_GATEWAY_PREFIX)
    ? trimmed.slice(OPENAI_GATEWAY_PREFIX.length)
    : trimmed;

  if (slug.length === 0 || slug.includes("/")) {
    throw new Error(
      `experimental_codex expects a bare OpenAI model slug such as "gpt-5.5", received "${model}".`,
    );
  }

  return slug;
}
