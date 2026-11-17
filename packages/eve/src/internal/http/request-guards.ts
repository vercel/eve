import { isLoopbackHostname } from "#shared/network-address.js";

export type PlainHttpPolicy = "loopback" | "forwarded-https" | "allow";

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
    return securityError(
      plainHttp === "forwarded-https"
        ? `${protocol} endpoints require HTTPS: this request arrived over HTTP without X-Forwarded-Proto: https from the proxy.`
        : `${protocol} endpoints require HTTPS except on loopback.`,
    );
  }

  const hostFailure = validateHostHeader(request, target);
  if (hostFailure !== undefined) return hostFailure;
  return undefined;
}

export function clientUrl(request: Request, plainHttp: PlainHttpPolicy = "loopback"): URL {
  const url = new URL(request.url);
  if (plainHttp !== "forwarded-https" || url.protocol !== "http:") return url;
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded !== "https") return url;
  const client = new URL(url);
  client.protocol = "https:";
  const port = request.headers.get("x-forwarded-port")?.split(",")[0]?.trim();
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
