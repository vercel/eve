import { isLoopbackHostname } from "#shared/network-address.js";

/**
 * When a protocol endpoint accepts a request that reached eve over plain HTTP:
 *
 * - `"loopback"`: only from a loopback host, such as a local `eve dev`.
 * - `"forwarded-https"`: also when `X-Forwarded-Proto` says the client used HTTPS, for a proxy
 *   that terminates TLS and sets the header itself. Any client can send the header, so use this
 *   only when every request passes through such a proxy.
 * - `"allow"`: from any host, for a network kept private some other way, such as calls between
 *   services in one cluster.
 */
export type PlainHttpPolicy = "loopback" | "forwarded-https" | "allow";

/**
 * Applies the fetch-native HTTP guards in front of a protocol endpoint, such as MCP's. `protocol`
 * names it in error messages.
 *
 * Non-browser clients normally omit `Origin`; browser requests are restricted
 * to the endpoint's exact origin. Plain HTTP is accepted as `plainHttp` says, by default only
 * on loopback.
 */
export function validateHttpEndpointRequest(
  request: Request,
  protocol: string,
  plainHttp: PlainHttpPolicy = "loopback",
): Response | undefined {
  const baseFailure = validateTransportAndHost(request, protocol, plainHttp);
  if (baseFailure !== undefined) return baseFailure;

  const target = clientUrl(request, plainHttp);
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
 * Applies transport and Host validation to a public metadata route, such as OAuth discovery,
 * without restricting its Origin. The route itself supplies permissive CORS.
 */
export function validateHttpMetadataRequest(
  request: Request,
  protocol: string,
  plainHttp: PlainHttpPolicy = "loopback",
): Response | undefined {
  return validateTransportAndHost(request, protocol, plainHttp);
}

function validateTransportAndHost(
  request: Request,
  protocol: string,
  plainHttp: PlainHttpPolicy,
): Response | undefined {
  let target: URL;
  try {
    target = new URL(request.url);
  } catch {
    return securityError(`Invalid ${protocol} request URL.`, 400);
  }

  const scheme = clientUrl(request, plainHttp).protocol;
  if (
    scheme !== "https:" &&
    !(scheme === "http:" && (plainHttp === "allow" || isLoopbackHostname(target.hostname)))
  ) {
    return securityError(`${protocol} endpoints require HTTPS except on loopback.`);
  }

  const hostFailure = validateHostHeader(request, target);
  if (hostFailure !== undefined) return hostFailure;
  return undefined;
}

/**
 * The request's URL as its client addressed it: under `"forwarded-https"`, an HTTP request that
 * `X-Forwarded-Proto` says arrived over HTTPS reads as HTTPS, on the port `X-Forwarded-Port`
 * names, or the default one. Use it for URLs an endpoint advertises back to the client. Only the
 * scheme and port change; the Host check compares the URL eve received.
 */
export function clientUrl(request: Request, plainHttp: PlainHttpPolicy = "loopback"): URL {
  const url = new URL(request.url);
  if (plainHttp !== "forwarded-https" || url.protocol !== "http:") return url;
  // The first value is the hop nearest the client.
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded !== "https") return url;
  const client = new URL(url);
  client.protocol = "https:";
  const port = request.headers.get("x-forwarded-port")?.split(",")[0]?.trim();
  // A port that isn't one is ignored rather than trusted into a URL.
  client.port = port !== undefined && /^\d{1,5}$/u.test(port) && Number(port) <= 65_535 ? port : "";
  return client;
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
