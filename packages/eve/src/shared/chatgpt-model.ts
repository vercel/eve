export const DEFAULT_CHATGPT_MODEL_ID = "gpt-5.6-sol";
export const CHATGPT_MODEL_SELECTION_PREFIX = "chatgpt/";
export const DEFAULT_CHATGPT_MODEL_SELECTION = `${CHATGPT_MODEL_SELECTION_PREFIX}${DEFAULT_CHATGPT_MODEL_ID}`;

/** Returns the bare OpenAI model id encoded by a setup-facing ChatGPT selection. */
export function parseChatGptModelSelection(selection: string): string | undefined {
  if (!selection.startsWith(CHATGPT_MODEL_SELECTION_PREFIX)) return undefined;
  const modelId = selection.slice(CHATGPT_MODEL_SELECTION_PREFIX.length);
  return isBareChatGptModelId(modelId) ? modelId : undefined;
}

export function isChatGptModelSelection(selection: string): boolean {
  return parseChatGptModelSelection(selection) !== undefined;
}

/** Normalizes the model argument accepted by the public `chatgpt()` helper. */
export function normalizeChatGptModelId(model: string): string | undefined {
  const trimmed = model.trim();
  const modelId = trimmed.startsWith("openai/") ? trimmed.slice("openai/".length) : trimmed;
  return isBareChatGptModelId(modelId) ? modelId : undefined;
}

function isBareChatGptModelId(modelId: string): boolean {
  return modelId.length > 0 && modelId === modelId.trim() && !modelId.includes("/");
}
