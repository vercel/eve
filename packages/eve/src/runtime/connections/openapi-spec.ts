import matter from "#compiled/gray-matter/index.js";
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
  const parsed = matter(wrapped);
  return parsed.data ?? {};
}

/**
 * Picks a base URL from an OpenAPI document's `servers` array.
 *
 * Returns the first server whose URL resolves to an absolute `http(s)`
 * origin: `{var}` placeholders are substituted with each variable's
 * `default`, and a relative URL (e.g. `/api/v3`) is resolved against
 * `specSource` when the spec was supplied as a URL. Returns `undefined`
 * when no entry yields an absolute URL.
 */
export function extractServerUrl(
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
