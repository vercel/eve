import type { NuxtApp } from "#app";

/**
 * Reuse SSR or prior navigation payload instead of refetching on client-side route changes.
 */
export function getCachedPayloadData<T>(key: string, nuxtApp?: NuxtApp): T | undefined {
  const app = nuxtApp ?? useNuxtApp();
  return app.payload.data[key] ?? app.static.data[key];
}

export const payloadCacheOptions = {
  getCachedData: getCachedPayloadData,
} as const;

export function clearCachedPayloadData(key: string, nuxtApp?: NuxtApp) {
  const app = nuxtApp ?? useNuxtApp();
  delete app.payload.data[key];
  delete app.static.data[key];
}
