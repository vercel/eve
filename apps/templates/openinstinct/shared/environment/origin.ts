import { env } from "@shared/environment";

export function applicationOrigin() {
  if (env.BETTER_AUTH_URL) return new URL(env.BETTER_AUTH_URL).origin;

  if (env.VERCEL_ENV) {
    const hostname =
      env.VERCEL_PROJECT_PRODUCTION_URL ??
      env.VERCEL_URL ??
      env.VERCEL_BRANCH_URL;
    if (hostname) return new URL(`https://${hostname}`).origin;
  }

  throw new Error(
    "The application origin is unavailable. Set BETTER_AUTH_URL outside Vercel."
  );
}

export function betterAuthBaseURL() {
  const fallback = applicationOrigin();
  if (!env.VERCEL_ENV) return fallback;

  const allowedHosts = new Set(
    [
      "*.vercel.app",
      new URL(fallback).host,
      env.VERCEL_BRANCH_URL,
      env.VERCEL_PROJECT_PRODUCTION_URL,
      env.VERCEL_URL,
    ].filter((hostname): hostname is string => hostname !== undefined)
  );

  return {
    allowedHosts: [...allowedHosts],
    fallback,
    protocol: "https" as const,
  };
}
