import type { LanguageModel } from "ai";

/**
 * A model-serving backend: turns one compiled runtime model reference into
 * the AI SDK language model that serves it. Each endpoint (AI Gateway, local
 * Codex login) owns its own credential and transport wiring behind this
 * boundary.
 */
export interface ModelEndpointFactory {
  createModel(reference: { readonly id: string }): LanguageModel;
}
