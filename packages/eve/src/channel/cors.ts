/**
 * Serializable subset of H3/Nitro CORS options supported by channel routes.
 *
 * Function and RegExp origins are intentionally excluded because channel
 * definitions are compiled into JSON artifacts and virtual Nitro handlers.
 */
export interface ChannelCorsOptions {
  /**
   * Allowed request origins. Omit or pass `"*"` for all origins, pass
   * `"null"` for the literal `null` origin, or pass an array of exact origins.
   */
  readonly origin?: "*" | "null" | readonly string[];
  /** Methods emitted on preflight responses. Omit or pass `"*"` for all methods. */
  readonly methods?: "*" | readonly string[];
  /**
   * Request headers emitted on preflight responses. Omit or pass `"*"` to
   * allow requested headers.
   */
  readonly allowHeaders?: "*" | readonly string[];
  /** Response headers exposed to browser callers. Omit or pass `"*"` for all headers. */
  readonly exposeHeaders?: "*" | readonly string[];
  /** Whether to emit `access-control-allow-credentials: true`. */
  readonly credentials?: boolean;
  /** Max age, in seconds, emitted on preflight responses. */
  readonly maxAge?: string | number | false;
  /** Preflight response customization. */
  readonly preflight?: {
    readonly statusCode?: number;
  };
}

export type ChannelCors = boolean | ChannelCorsOptions;

export interface NormalizedChannelCorsOptions {
  readonly origin?: "*" | "null" | readonly string[];
  readonly methods?: "*" | readonly string[];
  readonly allowHeaders?: "*" | readonly string[];
  readonly exposeHeaders?: "*" | readonly string[];
  readonly credentials?: boolean;
  readonly maxAge?: string | false;
  readonly preflight?: {
    readonly statusCode?: number;
  };
}

export function normalizeChannelCors(
  cors: ChannelCors | undefined,
): NormalizedChannelCorsOptions | undefined {
  if (cors === undefined || cors === false) {
    return undefined;
  }

  if (cors === true) {
    return {};
  }

  if (cors === null || typeof cors !== "object" || Array.isArray(cors)) {
    throw new Error("Expected channel cors to be a boolean or a serializable CORS options object.");
  }

  const normalized: MutableNormalizedChannelCorsOptions = {};

  if (cors.origin !== undefined) {
    normalized.origin = normalizeOrigin(cors.origin);
  }
  if (cors.methods !== undefined) {
    normalized.methods = normalizeWildcardOrStringList(cors.methods, "methods");
  }
  if (cors.allowHeaders !== undefined) {
    normalized.allowHeaders = normalizeWildcardOrStringList(cors.allowHeaders, "allowHeaders");
  }
  if (cors.exposeHeaders !== undefined) {
    normalized.exposeHeaders = normalizeWildcardOrStringList(cors.exposeHeaders, "exposeHeaders");
  }
  if (cors.credentials !== undefined) {
    if (typeof cors.credentials !== "boolean") {
      throw new Error("Expected channel cors.credentials to be a boolean.");
    }
    normalized.credentials = cors.credentials;
  }
  if (cors.maxAge !== undefined) {
    normalized.maxAge = normalizeMaxAge(cors.maxAge);
  }
  if (cors.preflight !== undefined) {
    normalized.preflight = normalizePreflight(cors.preflight);
  }

  return normalized;
}

type MutableNormalizedChannelCorsOptions = {
  -readonly [K in keyof NormalizedChannelCorsOptions]: NormalizedChannelCorsOptions[K];
};

function normalizeOrigin(origin: ChannelCorsOptions["origin"]): "*" | "null" | readonly string[] {
  if (origin === "*" || origin === "null") {
    return origin;
  }

  if (!Array.isArray(origin)) {
    throw new Error('Expected channel cors.origin to be "*", "null", or an array of origins.');
  }

  return origin.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error("Expected channel cors.origin entries to be non-empty strings.");
    }
    return entry;
  });
}

function normalizeWildcardOrStringList(
  value: "*" | readonly string[],
  label: "allowHeaders" | "exposeHeaders" | "methods",
): "*" | readonly string[] {
  if (value === "*") {
    return value;
  }

  if (!Array.isArray(value)) {
    throw new Error(`Expected channel cors.${label} to be "*" or an array of strings.`);
  }

  return value.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(`Expected channel cors.${label} entries to be non-empty strings.`);
    }
    return entry;
  });
}

function normalizeMaxAge(maxAge: ChannelCorsOptions["maxAge"]): string | false {
  if (maxAge === false) {
    return false;
  }

  if (typeof maxAge === "number") {
    if (!Number.isFinite(maxAge) || maxAge < 0) {
      throw new Error("Expected channel cors.maxAge to be a non-negative finite number.");
    }
    return String(maxAge);
  }

  if (typeof maxAge === "string" && maxAge.length > 0) {
    return maxAge;
  }

  throw new Error("Expected channel cors.maxAge to be false, a string, or a number.");
}

function normalizePreflight(
  preflight: ChannelCorsOptions["preflight"],
): NormalizedChannelCorsOptions["preflight"] {
  if (preflight === null || typeof preflight !== "object" || Array.isArray(preflight)) {
    throw new Error("Expected channel cors.preflight to be an object.");
  }

  const statusCode = preflight.statusCode;
  if (statusCode === undefined) {
    return {};
  }

  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    throw new Error("Expected channel cors.preflight.statusCode to be an HTTP status code.");
  }

  return { statusCode };
}
