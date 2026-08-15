import { parseFrontmatter } from "#internal/helpers/gray-matter.js";
import { isArray } from "#runtime/connections/openapi-schema.js";
import { isObject } from "#shared/guards.js";

/**
 * Parses a fetched spec body as either JSON or YAML.
 *
 * JSON is tried first (the common case and fastest path); on a parse
 * failure the body is treated as YAML. YAML is parsed by wrapping the
 * document in front-matter delimiters so the bundled `gray-matter`
 * engine reads the whole file — the same approach the eval YAML loader
 * uses, avoiding a second YAML dependency.
 */
export function parseSpecDocument(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON — fall through to YAML.
  }
  const body = text.replace(/^\uFEFF/, "");
  const wrapped = body.trimStart().startsWith("---") ? body : `---\n${body}\n---`;
  return parseFrontmatter(wrapped).data;
}

/**
 * Picks a base URL from an OpenAPI document.
 *
 * OpenAPI 3.x documents use `servers`; Swagger 2.0 documents use
 * `schemes`/`host`/`basePath`. Returns `undefined` when neither shape
 * yields an absolute HTTP(S) URL.
 */
export function extractServerUrl(
  document: Record<string, unknown>,
  specSource: string | Record<string, unknown> | undefined,
): string | undefined {
  const openApiUrl = extractOpenApiServerUrl(document, specSource);
  if (openApiUrl !== undefined) {
    return openApiUrl;
  }
  return extractSwaggerBaseUrl(document, specSource);
}

/**
 * Returns the first OpenAPI 3.x server whose URL resolves to an absolute
 * `http(s)` origin: `{var}` placeholders are substituted with each
 * variable's `default`, and a relative URL (e.g. `/api/v3`) is resolved
 * against `specSource` when the spec was supplied as a URL.
 */
function extractOpenApiServerUrl(
  document: Record<string, unknown>,
  specSource: string | Record<string, unknown> | undefined,
): string | undefined {
  const servers = document.servers;
  if (!isArray(servers)) {
    return undefined;
  }
  for (const server of servers) {
    if (!isObject(server) || typeof server.url !== "string" || server.url.length === 0) {
      continue;
    }
    const url = isObject(server.variables)
      ? substituteServerVariables(server.url, server.variables)
      : server.url;
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return url;
    }
    if (typeof specSource === "string" && URL.canParse(specSource)) {
      try {
        return new URL(url, specSource).toString();
      } catch {
        // fall through to the next server entry
      }
    }
  }
  return undefined;
}

/** Builds the Swagger 2.0 base URL from `schemes`, `host`, and `basePath`. */
function extractSwaggerBaseUrl(
  document: Record<string, unknown>,
  specSource: string | Record<string, unknown> | undefined,
): string | undefined {
  const basePath = typeof document.basePath === "string" ? document.basePath : "";
  const host = typeof document.host === "string" && document.host.length > 0 ? document.host : "";
  const specUrl =
    typeof specSource === "string" && URL.canParse(specSource) ? new URL(specSource) : undefined;
  const scheme = extractSwaggerScheme(document) ?? specUrl?.protocol.replace(/:$/, "") ?? "https";

  if (host.length > 0) {
    return `${scheme}://${host}${normalizeBasePath(basePath)}`;
  }

  if (specUrl !== undefined) {
    const url = new URL(normalizeBasePath(basePath) || "/", specUrl.origin);
    const text = url.toString();
    return text.endsWith("/") && normalizeBasePath(basePath).length === 0
      ? text.slice(0, -1)
      : text;
  }

  return undefined;
}

/** Picks the first HTTP(S) scheme from a Swagger 2.0 `schemes` array. */
function extractSwaggerScheme(document: Record<string, unknown>): "http" | "https" | undefined {
  const schemes = document.schemes;
  if (!isArray(schemes)) {
    return undefined;
  }
  for (const scheme of schemes) {
    if (scheme === "https" || scheme === "http") {
      return scheme;
    }
  }
  return undefined;
}

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.trim();
  if (trimmed.length === 0 || trimmed === "/") {
    return "";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** Replaces `{name}` placeholders in a server URL with each variable's `default`. */
function substituteServerVariables(url: string, variables: Record<string, unknown>): string {
  return url.replace(/\{([^}]+)\}/g, (match, name: string) => {
    const variable = variables[name];
    if (isObject(variable) && typeof variable.default === "string") {
      return variable.default;
    }
    return match;
  });
}
