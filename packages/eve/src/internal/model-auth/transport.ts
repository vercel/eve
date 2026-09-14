import { createGateway, type LanguageModel } from "ai";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { readModelSecret, modelKeySecretName } from "./store.js";
import { readVercelCliConnection, refreshVercelCliConnection } from "./vercel-cli.js";
import { resolveVercelSession, VERCEL_TEAM_HEADER } from "./vercel.js";

import { MODEL_CONNECTION_ENV } from "#shared/model-helper.js";
export { MODEL_CONNECTION_ENV } from "#shared/model-helper.js";
const KEY_ENV = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  "ai-gateway-key": "AI_GATEWAY_API_KEY",
} as const;

export async function resolveModelApiKey(provider: keyof typeof KEY_ENV): Promise<string> {
  const value = process.env[KEY_ENV[provider]];
  const source =
    isEveDevEnvironment() && process.env[MODEL_CONNECTION_ENV] === provider
      ? process.env.EVE_MODEL_KEY_SOURCE
      : undefined;
  if (value?.trim() && source !== "secret") return value;
  if (isEveDevEnvironment() && source !== "environment") {
    const stored = await readModelSecret(modelKeySecretName(provider));
    if (stored) return stored;
  }
  if (source === "secret")
    throw new Error("The selected saved API key is unavailable. Run /login to reconnect.");
  throw new Error(
    `Set ${KEY_ENV[provider]}${isEveDevEnvironment() ? " or connect with /login" : " in the server environment"}.`,
  );
}

export function createDirectModelFetch(provider: "openai" | "anthropic"): typeof fetch {
  return async (url, init) => {
    const headers = new Headers(init?.headers);
    const key = await resolveModelApiKey(provider);
    headers.set(
      provider === "openai" ? "authorization" : "x-api-key",
      provider === "openai" ? `Bearer ${key}` : key,
    );
    return fetch(url, { ...init, headers });
  };
}

/** Construct providers at request time so credential rotation never enters compiled state. */
export function localGatewayModel(id: string): LanguageModel | undefined {
  if (!isEveDevEnvironment()) return undefined;
  const selected = process.env[MODEL_CONNECTION_ENV];
  if (selected !== "vercel" && selected !== "vercel-cli" && selected !== "ai-gateway-key")
    return undefined;
  return createGateway({
    apiKey: "eve-local-credential",
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      if (selected === "ai-gateway-key") {
        headers.set("authorization", `Bearer ${await resolveModelApiKey("ai-gateway-key")}`);
      } else {
        const credential =
          selected === "vercel" ? await resolveVercelSession() : await readVercelCliConnection();
        if (!credential) throw new Error("Vercel CLI credentials are unavailable. Run /login.");
        headers.set(
          "authorization",
          `Bearer ${"accessToken" in credential ? credential.accessToken : credential.token}`,
        );
        headers.set(VERCEL_TEAM_HEADER, process.env.EVE_MODEL_TEAM ?? credential.teamId);
      }
      const response = await fetch(url, { ...init, headers });
      if (
        response.status !== 401 ||
        selected === "ai-gateway-key" ||
        (init?.body !== undefined && init.body !== null && typeof init.body !== "string")
      )
        return response;
      await response.body?.cancel();
      if (selected === "vercel") {
        const session = await resolveVercelSession(headers.get("authorization")?.slice(7));
        headers.set("authorization", `Bearer ${session.accessToken}`);
      } else {
        await refreshVercelCliConnection();
        const cli = await readVercelCliConnection();
        if (!cli) throw new Error("Vercel CLI credentials are unavailable. Run /login.");
        headers.set("authorization", `Bearer ${cli.token}`);
      }
      return fetch(url, { ...init, headers });
    },
  })(id);
}
