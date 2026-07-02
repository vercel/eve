import type { LanguageModel } from "ai";
import type { ModelEndpointStatus } from "#shared/model-endpoint-status.js";

/**
 * A model-serving backend: turns one compiled runtime model reference into
 * the AI SDK language model that serves it, and reports whether it can
 * currently serve calls. Each endpoint (AI Gateway, local Codex login) owns
 * its own credential and transport wiring behind this boundary.
 *
 * `TStatusOptions` carries the endpoint's injectable seams for status
 * resolution (clocks, env, credential readers); production callers pass
 * nothing.
 */
export interface ModelEndpointFactory<TStatusOptions = unknown> {
  createModel(reference: { readonly id: string }): LanguageModel;
  resolveStatus(options?: TStatusOptions): Promise<ModelEndpointStatus>;
}
