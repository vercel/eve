export function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }

  const requestUrl = new URL(request.url);
  const allowedOrigins = new Set([requestUrl.origin]);
  const protocol =
    firstForwardedValue(request.headers.get("x-forwarded-proto")) ??
    requestUrl.protocol;

  for (const value of [
    request.headers.get("x-forwarded-host"),
    request.headers.get("host"),
  ]) {
    const host = firstForwardedValue(value);
    if (!host) continue;
    try {
      allowedOrigins.add(
        new URL(`${normalizeProtocol(protocol)}//${host}`).origin
      );
    } catch {
      continue;
    }
  }

  return allowedOrigins.has(parsedOrigin.origin);
}

function firstForwardedValue(value: string | null) {
  const first = value?.split(",", 1)[0]?.trim();
  return first?.length ? first : undefined;
}

function normalizeProtocol(protocol: string) {
  return protocol.endsWith(":") ? protocol : `${protocol}:`;
}
