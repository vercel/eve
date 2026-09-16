import { createGateway, type LanguageModel } from "ai";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { resolveModelApiKey } from "./api-key.js";
import {
  developmentModelBrokerAvailable,
  readDevelopmentModelCredential,
} from "./development-broker-client.js";
import { resolveGatewayModelCredential } from "./gateway-credential.js";
import { VERCEL_TEAM_HEADER } from "./vercel.js";
import { MODEL_CONNECTION_ENV } from "#shared/model-helper.js";

export { MODEL_CONNECTION_ENV } from "#shared/model-helper.js";
export { resolveModelApiKey } from "./api-key.js";

export function createDirectModelFetch(provider: "openai" | "anthropic"): typeof fetch {
  return async (url, init) => {
    const headers = new Headers(init?.headers);
    const credential = await readDevelopmentModelCredential(provider, undefined, init?.signal);
    const key = credential?.token ?? (await resolveModelApiKey(provider));
    headers.set(
      provider === "openai" ? "authorization" : "x-api-key",
      provider === "openai" ? `Bearer ${key}` : key,
    );
    return fetch(url, { ...init, headers });
  };
}

/** Resolve the connection for every request, including models constructed before /login. */
export function localGatewayModel(id: string): LanguageModel | undefined {
  if (!isEveDevEnvironment()) return undefined;
  const selected = process.env[MODEL_CONNECTION_ENV];
  if (
    !developmentModelBrokerAvailable() &&
    selected !== "vercel" &&
    selected !== "vercel-cli" &&
    selected !== "ai-gateway-key" &&
    selected !== "ai-gateway-project"
  )
    return undefined;
  const resolve = async (rejectedToken?: string, signal?: AbortSignal | null) =>
    (await readDevelopmentModelCredential("gateway", rejectedToken, signal)) ??
    (await resolveGatewayModelCredential(rejectedToken));
  return createGateway({
    apiKey: "eve-local-credential",
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      const authenticate = (credential: Awaited<ReturnType<typeof resolve>>) => {
        headers.set("authorization", `Bearer ${credential.token}`);
        headers.delete(VERCEL_TEAM_HEADER);
        if (credential.teamId) headers.set(VERCEL_TEAM_HEADER, credential.teamId);
      };
      const credential = await resolve(undefined, init?.signal);
      authenticate(credential);
      const response = await fetch(url, { ...init, headers });
      if (
        response.status !== 401 ||
        credential.kind !== "oauth" ||
        (init?.body !== undefined && init.body !== null && typeof init.body !== "string")
      )
        return response;
      await response.body?.cancel();
      authenticate(await resolve(credential.token, init?.signal));
      return fetch(url, { ...init, headers });
    },
  })(id);
}
