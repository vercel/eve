import { parseYaml } from "#internal/helpers/frontmatter.js";
import { isArray } from "#runtime/connections/openapi-schema.js";
import { isObject } from "#shared/guards.js";

export function parseSpecDocument(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {}
  return parseYaml(text.replace(/^\uFEFF/, ""));
}

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
      } catch {}
    }
  }
  return undefined;
}

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

function substituteServerVariables(url: string, variables: Record<string, unknown>): string {
  return url.replace(/\{([^}]+)\}/g, (match, name: string) => {
    const variable = variables[name];
    if (isObject(variable) && typeof variable.default === "string") {
      return variable.default;
    }
    return match;
  });
}
