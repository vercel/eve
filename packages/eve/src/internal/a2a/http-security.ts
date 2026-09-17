import { isLoopbackHostname } from "#shared/network-address.js";

/** Validates the transport, Host, Origin, and media type for an A2A HTTP request. */
export function validateA2AHttpRequest(request: Request): Response | undefined {
  let target: URL;
  try {
    target = new URL(request.url);
  } catch {
    return error("Invalid A2A request URL.", 400);
  }
  if (
    target.protocol !== "https:" &&
    !(target.protocol === "http:" && isLoopbackHostname(target.hostname))
  ) {
    return error("A2A endpoints require HTTPS except on loopback.");
  }
  const host = request.headers.get("host");
  if (host === null || host.length === 0) return error("Missing Host header");
  if (host !== target.host) return error(`Invalid Host header: ${host}`);

  const origin = request.headers.get("origin");
  if (origin !== null && origin.length > 0) {
    try {
      if (new URL(origin).origin !== target.origin) return error(`Invalid Origin: ${origin}`);
    } catch {
      return error("Invalid Origin header.");
    }
  }
  if (request.method === "POST") {
    const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json")
      return error("A2A requests require application/json.", 415);
  }
  return undefined;
}

function error(message: string, status = 403): Response {
  return Response.json({ error: { code: -32_000, message }, id: null, jsonrpc: "2.0" }, { status });
}
