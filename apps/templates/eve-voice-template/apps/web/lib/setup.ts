import { isDatabaseConfigured, isDatabaseSchemaReady } from "./db/client";

export type AuthMode = "local-dev" | "password" | "unconfigured" | "vercel";

export type SetupStatus = {
  readonly appReady: boolean;
  readonly authMode: AuthMode;
  readonly gatewayReady: boolean;
  readonly missing: readonly string[];
};

const AUTH_ENV_KEYS = [
  "BETTER_AUTH_SECRET",
  "NEXT_PUBLIC_VERCEL_APP_CLIENT_ID",
  "VERCEL_APP_CLIENT_SECRET",
] as const;

const RATE_LIMIT_ENV_GROUPS = [
  ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
  ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
] as const;

function hasEnv(name: string) {
  return Boolean(process.env[name]?.trim());
}

export function isAuthConfigured() {
  return AUTH_ENV_KEYS.every(hasEnv);
}

export function isRateLimitConfigured() {
  return RATE_LIMIT_ENV_GROUPS.some((group) => group.every(hasEnv));
}

export async function getSetupStatus(): Promise<SetupStatus> {
  // GPT-Live-1 client secrets can only be minted with a Gateway API key, not OIDC.
  const gatewayReady = hasEnv("AI_GATEWAY_API_KEY");
  const gatewayMissing = gatewayReady ? [] : ["AI_GATEWAY_API_KEY"];
  const fullEnvironmentReady =
    isDatabaseConfigured() && isAuthConfigured() && isRateLimitConfigured();

  if (fullEnvironmentReady) {
    const databaseSchemaReady = await isDatabaseSchemaReady();

    return {
      appReady: databaseSchemaReady && gatewayReady,
      authMode: "vercel",
      gatewayReady,
      missing: [...gatewayMissing, ...(databaseSchemaReady ? [] : ["database migrations"])],
    };
  }

  if (hasEnv("EVE_VOICE_PASSWORD") || isLocalDevelopment()) {
    return {
      appReady: gatewayReady,
      authMode: hasEnv("EVE_VOICE_PASSWORD") ? "password" : "local-dev",
      gatewayReady,
      missing: gatewayMissing,
    };
  }

  return {
    appReady: false,
    authMode: "unconfigured",
    gatewayReady,
    missing: [
      ...gatewayMissing,
      "EVE_VOICE_PASSWORD, or DATABASE_URL plus Better Auth/Vercel OAuth and Upstash configuration",
    ],
  };
}

// `vercel dev` sets VERCEL=1 too, so only the Node environment marks local dev.
function isLocalDevelopment() {
  return process.env.NODE_ENV === "development";
}
