/**
 * Builds the `control.url` Eve mints into the Gateway realtime token: the public
 * `wss://` URL of Eve's own WebSocket control route that AI Gateway dials back.
 *
 * Resolution order:
 *  1. `EVE_REALTIME_CONTROL_URL` (or the explicit override) — a full `wss://`
 *     (or `ws://localhost`) URL, used for tunneled local dev (ngrok/preview).
 *  2. The deployment host from `VERCEL_BRANCH_URL` / `VERCEL_URL` /
 *     `VERCEL_PROJECT_PRODUCTION_URL`.
 *
 * AI Gateway dials this URL with only an `Authorization` header and does not
 * follow redirects, so a Vercel Deployment Protection bypass cannot ride a
 * header — it is appended to the URL as the `x-vercel-protection-bypass` query
 * param for Vercel deployment hosts only (read from
 * `VERCEL_AUTOMATION_BYPASS_SECRET`, falling back to `VERCEL_DPBP`). This is a
 * temporary measure for protected preview testing.
 */
export interface ResolveControlUrlInput {
  /** The `/ws` route path, e.g. `/eve/v1/realtime-speech/ws`. */
  readonly wsPath: string;
  /** Explicit full WS URL override (defaults to `EVE_REALTIME_CONTROL_URL`). */
  readonly explicitUrl?: string;
  /** Explicit deploy-protection bypass secret override. */
  readonly bypassSecret?: string;
}

export function resolveControlUrl(input: ResolveControlUrlInput): string {
  const base = resolveBaseUrl(input);
  const bypass = readNonEmpty(input.bypassSecret) ?? readDeployBypassSecret();
  if (bypass !== undefined && isVercelHost(base.hostname)) {
    base.searchParams.set("x-vercel-protection-bypass", bypass);
  }
  return base.toString();
}

function resolveBaseUrl(input: ResolveControlUrlInput): URL {
  const explicit =
    readNonEmpty(input.explicitUrl) ?? readNonEmpty(process.env.EVE_REALTIME_CONTROL_URL);
  if (explicit !== undefined) {
    // The override carries the full URL including path; honor it verbatim.
    return validateControlUrl(new URL(explicit));
  }

  const host = resolveDeploymentHost();
  if (host === undefined) {
    throw new Error(
      "Eve realtime voice control could not resolve a public host. Set EVE_REALTIME_CONTROL_URL.",
    );
  }
  const scheme = isLocalHost(host) ? "ws" : "wss";
  return validateControlUrl(new URL(`${scheme}://${host}${input.wsPath}`));
}

function resolveDeploymentHost(): string | undefined {
  const fromEnv =
    readNonEmpty(process.env.VERCEL_BRANCH_URL) ??
    readNonEmpty(process.env.VERCEL_URL) ??
    readNonEmpty(process.env.VERCEL_PROJECT_PRODUCTION_URL);
  if (fromEnv !== undefined) return stripScheme(fromEnv);

  return undefined;
}

function readDeployBypassSecret(): string | undefined {
  return (
    readNonEmpty(process.env.VERCEL_AUTOMATION_BYPASS_SECRET) ??
    readNonEmpty(process.env.VERCEL_DPBP)
  );
}

function isLocalHost(host: string): boolean {
  const hostname = host.split(":")[0] ?? host;
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1";
}

function isVercelHost(hostname: string): boolean {
  return hostname.endsWith(".vercel.app") || hostname.endsWith(".vercel.sh");
}

function validateControlUrl(url: URL): URL {
  if (url.protocol === "wss:") return url;
  if (url.protocol === "ws:" && isLocalHost(url.host)) return url;
  throw new Error(
    "Eve realtime voice control URL must use wss://, or ws://localhost for local dev.",
  );
}

function stripScheme(value: string): string {
  return value.replace(/^[a-z]+:\/\//iu, "");
}

function readNonEmpty(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
