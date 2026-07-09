import { createVercelSandbox } from "#execution/sandbox/bindings/vercel.js";
import type { SandboxBackend } from "#public/definitions/sandbox-backend.js";
import type {
  IsloSandboxBootstrapUseOptions,
  IsloSandboxCreateOptions,
  IsloSandboxSessionUseOptions,
} from "#public/sandbox/islo-sandbox.js";

const DEFAULT_ISLO_API_BASE_URL = "https://api.islo.dev";

/**
 * Constructs the [Islo Sandbox provider](https://docs.islo.dev), which
 * exposes a Vercel-compatible sandbox API.
 *
 * The backend forwards Vercel-compatible sandbox options and rewrites
 * Vercel API calls to Islo's API base URL (`https://api.islo.dev` by
 * default). If `token` is omitted, `ISLO_TOKEN` then `ISLO_API_KEY` are
 * used when present.
 */
export function islo(
  opts?: IsloSandboxCreateOptions,
): SandboxBackend<IsloSandboxBootstrapUseOptions, IsloSandboxSessionUseOptions> {
  const { apiBaseUrl, fetch: fetchOverride, ...rest } = opts ?? {};
  const resolvedToken =
    rest.token ??
    readNonEmptyEnvironmentVariable("ISLO_TOKEN") ??
    readNonEmptyEnvironmentVariable("ISLO_API_KEY");
  const resolvedApiBaseUrl = normalizeApiBaseUrl(apiBaseUrl);

  const createOptions = {
    ...rest,
    fetch: createIsloFetch({
      apiBaseUrl: resolvedApiBaseUrl,
      fetch: fetchOverride ?? globalThis.fetch,
    }),
  };
  if (resolvedToken === undefined) {
    delete createOptions.token;
  } else {
    createOptions.token = resolvedToken;
  }

  return createVercelSandbox({
    backendName: "islo",
    createOptions,
    providerName: "Islo",
  });
}

function createIsloFetch(input: {
  readonly apiBaseUrl: string;
  readonly fetch: typeof globalThis.fetch;
}): typeof globalThis.fetch {
  const apiBaseUrl = new URL(input.apiBaseUrl);
  return async (url, init) => {
    if (url instanceof Request) {
      const rewrittenUrl = rewriteVercelApiUrl(url.url, apiBaseUrl);
      const request = rewrittenUrl === url.url ? url : new Request(rewrittenUrl, url);
      return await input.fetch(request, init);
    }

    const originalUrl = typeof url === "string" ? url : url.toString();
    const rewrittenUrl = rewriteVercelApiUrl(originalUrl, apiBaseUrl);
    return await input.fetch(rewrittenUrl, init);
  };
}

function rewriteVercelApiUrl(url: string, apiBaseUrl: URL): string {
  const parsed = new URL(url, apiBaseUrl);
  if (!isVercelApiHost(parsed.hostname)) {
    return url;
  }

  // Preserve any path prefix on the configured base URL (e.g. a
  // self-hosted `https://host/api/v1`) by joining it with the Vercel
  // request path rather than letting the absolute request path replace it.
  const basePath = apiBaseUrl.pathname.replace(/\/+$/, "");
  const rewritten = new URL(apiBaseUrl);
  rewritten.pathname = `${basePath}${parsed.pathname}`;
  rewritten.search = parsed.search;
  rewritten.hash = parsed.hash;
  return rewritten.toString();
}

function isVercelApiHost(hostname: string): boolean {
  return hostname === "api.vercel.com" || hostname.endsWith(".vercel.com");
}

function normalizeApiBaseUrl(apiBaseUrl: string | undefined): string {
  if (apiBaseUrl === undefined) {
    return DEFAULT_ISLO_API_BASE_URL;
  }
  const trimmed = apiBaseUrl.trim();
  if (trimmed.length === 0) {
    return DEFAULT_ISLO_API_BASE_URL;
  }
  try {
    return new URL(trimmed).toString();
  } catch {
    throw new TypeError(
      `Invalid \`apiBaseUrl\` passed to islo(): ${JSON.stringify(apiBaseUrl)}. ` +
        `Provide an absolute URL such as "${DEFAULT_ISLO_API_BASE_URL}".`,
    );
  }
}

function readNonEmptyEnvironmentVariable(key: string): string | undefined {
  const value = process.env[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
