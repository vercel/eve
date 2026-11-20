export const EVE_PUBLIC_ROUTE_PREFIX_ENV = "EVE_PUBLIC_ROUTE_PREFIX";

export function normalizePublicRoutePrefix(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }

  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const normalized = prefixed.replace(/\/+$/, "");
  return normalized.length === 0 ? undefined : normalized;
}
