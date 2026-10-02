import type { ModelConnection, ModelConnectionSelection } from "#shared/model-connection.js";

export const LOGIN_CONNECTION_OPTIONS = [
  { command: "vercel", commandOrder: 0, value: "vercel", label: "Vercel Account" },
  {
    command: "vercel-api-key",
    commandOrder: 2,
    value: "ai-gateway-key",
    label: "Vercel AI Gateway API Key",
  },
  { command: "chatgpt", commandOrder: 1, value: "chatgpt", label: "ChatGPT Subscription" },
  { command: "openai-api-key", commandOrder: 3, value: "openai", label: "OpenAI API Key" },
  { command: "anthropic-api-key", commandOrder: 4, value: "anthropic", label: "Anthropic API Key" },
] as const satisfies readonly {
  command: string;
  commandOrder: number;
  value: ModelConnection;
  label: string;
}[];

export const CONNECTION_OPTIONS = LOGIN_CONNECTION_OPTIONS.map(({ value, label }) => ({
  value,
  label,
}));

export const LOGIN_CONNECTION_COMMAND_OPTIONS = [...LOGIN_CONNECTION_OPTIONS].sort(
  (left, right) => left.commandOrder - right.commandOrder,
);

export function loginConnectionForCommand(command: string): ModelConnectionSelection | undefined {
  return LOGIN_CONNECTION_OPTIONS.find((option) => option.command === command)?.value;
}

export const LOGIN_CONNECTION_COMMAND_HINT = LOGIN_CONNECTION_COMMAND_OPTIONS.map(
  (option) => option.command,
).join("|");
