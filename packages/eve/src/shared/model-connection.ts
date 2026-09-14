export const CONNECTIONS = ["chatgpt", "vercel", "ai-gateway-key", "openai", "anthropic"] as const;
export type ModelConnection = (typeof CONNECTIONS)[number];
export type ModelConnectionSelection = ModelConnection | "ai-gateway-project" | "vercel-cli";
export function isModelConnection(value: unknown): value is ModelConnection {
  return CONNECTIONS.some((connection) => connection === value);
}
