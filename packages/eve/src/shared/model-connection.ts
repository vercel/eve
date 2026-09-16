export const CONNECTIONS = ["chatgpt", "vercel", "ai-gateway-key", "openai", "anthropic"] as const;
export type ModelConnection = (typeof CONNECTIONS)[number];
export type ModelConnectionSelection = ModelConnection | "ai-gateway-project" | "vercel-cli";
export function isModelConnection(value: unknown): value is ModelConnection {
  return CONNECTIONS.some((connection) => connection === value);
}

/** Whether a completed connection or model edit still needs runtime activation. */
export interface ModelAccessChange {
  kind: "model-access-changed";
  reload: boolean;
}
