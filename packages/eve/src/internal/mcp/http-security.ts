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

  const target = new URL(request.url);
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
  try {
    target = new URL(request.url);
  } catch {
    return securityError("Invalid MCP request URL.", 400);
  }

  if (
    target.protocol !== "https:" &&
    !(target.protocol === "http:" && isLoopbackHostname(target.hostname))
  ) {
    return securityError("MCP endpoints require HTTPS except on loopback.");
  }

  const hostFailure = validateHostHeader(request, target);
  if (hostFailure !== undefined) return hostFailure;
  return undefined;
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
