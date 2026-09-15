export const MODEL_CONNECTION_ENV = "EVE_MODEL_CONNECTION";
export const MODEL_HELPERS = {
  chatgpt: {
    module: "eve/models/openai",
    prefix: "chatgpt/",
    defaultModel: "gpt-5.6-luna-fast",
    provider: "codex",
  },
  openai: {
    module: "eve/models/openai",
    prefix: "openai-api/",
    defaultModel: "gpt-5.6-luna-fast",
    provider: "openai",
  },
  anthropic: {
    module: "eve/models/anthropic",
    prefix: "anthropic-api/",
    defaultModel: "claude-sonnet-5",
    provider: "anthropic",
  },
} as const;
export type ModelHelper = keyof typeof MODEL_HELPERS;
export function parseModelHelper(
  selection: string,
): { helper: ModelHelper; id: string } | undefined {
  for (const helper of Object.keys(MODEL_HELPERS) as ModelHelper[]) {
    const { prefix } = MODEL_HELPERS[helper];
    if (selection.startsWith(prefix)) {
      const id = selection.slice(prefix.length);
      if (id && id === id.trim() && !id.includes("/")) return { helper, id };
    }
  }
  return undefined;
}
