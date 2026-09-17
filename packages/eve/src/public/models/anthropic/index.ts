import type { LanguageModel } from "ai";
import { createAnthropic } from "#compiled/@ai-sdk/anthropic/index.js";
import { createDirectModelFetch } from "#internal/model-auth/transport.js";

/** Creates a direct Anthropic model. Uses ANTHROPIC_API_KEY, or /login credentials in local development. */
export function anthropic(model = "claude-sonnet-5"): LanguageModel {
  const id = model.trim().replace(/^anthropic\//u, "");
  if (!id || id.includes("/")) throw new Error("Expected an Anthropic model ID.");
  return createAnthropic({
    apiKey: "eve-local-credential",
    fetch: createDirectModelFetch("anthropic"),
  })(id);
}
