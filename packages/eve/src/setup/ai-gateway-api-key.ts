import { join } from "node:path";

import { appendEnv } from "./append-env.js";

export const AI_GATEWAY_API_KEY_ENV_VAR = "AI_GATEWAY_API_KEY";
export const AI_GATEWAY_API_KEY_ENV_FILE = ".env.local";

/** The location written by eve when a user supplies an AI Gateway API key. */
export interface AiGatewayApiKeyLocation {
  envKey: typeof AI_GATEWAY_API_KEY_ENV_VAR;
  envFile: typeof AI_GATEWAY_API_KEY_ENV_FILE;
  envPath: string;
}

/** Trims and saves an explicit AI Gateway API key, replacing any prior value. */
export async function writeAiGatewayApiKey(input: {
  projectRoot: string;
  apiKey: string;
  appendEnv?: typeof appendEnv;
}): Promise<AiGatewayApiKeyLocation> {
  const envPath = join(input.projectRoot, AI_GATEWAY_API_KEY_ENV_FILE);
  await (input.appendEnv ?? appendEnv)(
    envPath,
    { [AI_GATEWAY_API_KEY_ENV_VAR]: input.apiKey.trim() },
    { force: true },
  );
  return {
    envKey: AI_GATEWAY_API_KEY_ENV_VAR,
    envFile: AI_GATEWAY_API_KEY_ENV_FILE,
    envPath,
  };
}
