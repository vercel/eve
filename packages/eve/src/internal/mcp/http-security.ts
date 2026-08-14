import { isLoopbackHostname } from "#shared/network-address.js";

/**
 * Applies the fetch-native HTTP guards required in front of the MCP SDK.
 *
 * Non-browser clients normally omit `Origin`; browser requests are restricted
 * to the endpoint's exact origin. Plain HTTP is accepted only on loopback.
 */
export function validateMcpHttpRequest(request: Request): Response | undefined {
  const baseFailure = validateMcpHttpRequestBase(request);
  if (baseFailure !== undefined) return baseFailure;

  const target = resolveMcpPublicRequestUrl(request);
  const originHeader = request.headers.get("origin");
  if (originHeader === null || originHeader.length === 0) return undefined;

  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return securityError("Invalid Origin header.");
  }
  if (origin.origin !== target.origin) {
    return securityError(`Invalid Origin: ${origin.origin}`);
  }

  return undefined;
}

/**
 * Applies transport and Host validation to the public OAuth discovery route
 * without restricting its Origin. The route itself supplies permissive CORS.
 */
export function validateMcpMetadataRequest(request: Request): Response | undefined {
  return validateMcpHttpRequestBase(request);
}

function validateMcpHttpRequestBase(request: Request): Response | undefined {
  let target: URL;
  let publicTarget: URL;
  try {
    target = new URL(request.url);
    publicTarget = resolveMcpPublicRequestUrl(request);
  } catch {
    return securityError("Invalid MCP request URL or forwarded host.", 400);
  }

  if (!isSecureMcpTarget(target) || !isSecureMcpTarget(publicTarget)) {
    return securityError("MCP endpoints require HTTPS except on loopback.");
  }

  const hostFailure = validateHostHeader(request, target);
  if (hostFailure !== undefined) return hostFailure;
  return undefined;
}

function isSecureMcpTarget(target: URL): boolean {
  return (
    target.protocol === "https:" ||
    (target.protocol === "http:" && isLoopbackHostname(target.hostname))
  );
}

function pickFirstForwardedValue(value: string | null): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first === undefined || first.length === 0 ? undefined : first;
}

/** Resolves the public URL in front of an eve host integration or reverse proxy. */
export function resolveMcpPublicRequestUrl(request: Request): URL {
  const requestUrl = new URL(request.url);
  const forwardedHost = pickFirstForwardedValue(request.headers.get("x-forwarded-host"));
  const forwardedProto = pickFirstForwardedValue(request.headers.get("x-forwarded-proto"));
  if (forwardedHost === undefined && forwardedProto === undefined) return requestUrl;

  const protocol = forwardedProto ?? requestUrl.protocol.slice(0, -1);
  if (protocol !== "http" && protocol !== "https") {
    throw new TypeError("Unsupported forwarded protocol.");
  }
  const authority = new URL(`${protocol}://${forwardedHost ?? requestUrl.host}`);
  if (
    authority.username !== "" ||
    authority.password !== "" ||
    authority.pathname !== "/" ||
    authority.search !== "" ||
    authority.hash !== ""
  ) {
    throw new TypeError("Invalid forwarded host.");
  }
  return new URL(`${requestUrl.pathname}${requestUrl.search}`, authority);
}

function validateHostHeader(request: Request, target: URL): Response | undefined {
  const hostHeader = request.headers.get("host");
  if (hostHeader === null || hostHeader.length === 0) {
    return securityError("Missing Host header");
  }

  let authority: URL;
  try {
    authority = new URL(`${target.protocol}//${hostHeader}`);
  } catch {
    return securityError("Invalid Host header");
  }
  if (
    authority.username !== "" ||
    authority.password !== "" ||
    authority.pathname !== "/" ||
    authority.search !== "" ||
    authority.hash !== "" ||
    authority.host !== target.host
  ) {
    return securityError(`Invalid Host header: ${hostHeader}`);
  }
  return undefined;
}

function securityError(message: string, status = 403): Response {
  return Response.json(
    {
      error: { code: -32_000, message },
      id: null,
      jsonrpc: "2.0",
    },
    { headers: { "content-type": "application/json" }, status },
  );
}
