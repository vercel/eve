import type { JsonValue } from "../json";
/**
 * Content Management API transport. Requests preserve caller cancellation and never retry.
 *
 * @packageDocumentation
 */
import { API_HOST } from "./model";

/* Extra guidance appended to an API error, keyed by HTTP status. */
const STATUS_HINTS = new Map<number, string>(
  Object.entries({
    401: " Check that CONTENTFUL_MANAGEMENT_TOKEN is valid and has access to this space.",
    403: " Check that CONTENTFUL_MANAGEMENT_TOKEN is valid and has access to this space.",
    404: " The entry, environment, or space was not found.",
  }).map(([status, hint]) => [Number(status), hint])
);

/* Request options beyond the default GET. */
interface CallOptions {
  body?: string;
  headers?: Record<string, string>;
  method?: "GET" | "POST" | "PUT";
}

/* Contentful's error body; `details.errors` carries validation failures on 422. */
interface ApiErrorBody {
  details?: {
    errors?: { name?: string; path?: JsonValue[]; details?: string }[];
  };
  message?: string;
  sys?: { id?: string };
}

/* One line per validation failure, or the top-level message. */
const describeApiError = (body: ApiErrorBody): string => {
  const errors = body.details?.errors ?? [];
  if (errors.length > 0) {
    return errors
      .map(
        (e) =>
          `${(e.path ?? []).join(".") || "entry"}: ${e.details ?? e.name ?? "invalid"}`
      )
      .join("; ");
  }
  return body.message ?? body.sys?.id ?? "";
};

/* A failed CMA response, retaining its status for operation-specific handling. */
/** A failed CMA response retaining HTTP status for operation-specific recovery. */
export class ContentfulApiError extends Error {
  readonly status: number;

  /**
   * Creates an API failure with the status needed by recovery checks.
   *
   * @param status - HTTP status returned by Contentful.
   * @param message - Actionable error description without management credentials.
   */
  constructor(status: number, message: string) {
    super(message);
    this.name = "ContentfulApiError";
    this.status = status;
  }
}

/**
 * Send one Management API request with the management token and caller's signal.
 *
 * @typeParam T - Expected JSON response structure; this function does not validate it at runtime.
 * @param path - CMA path resolved against the API host, normally built with `spacePath`.
 * @param query - Query parameters; values are URL-encoded by the transport.
 * @param signal - Optional cancellation passed to fetch.
 * @param options - Method, serialized body, and extra headers; defaults to GET.
 * @returns Parsed JSON, or undefined for a 204 response (use `T = void`).
 * @throws {@link ContentfulApiError} for an unsuccessful HTTP response.
 * @throws {@link Error} If fetch, cancellation, or successful-response JSON decoding fails.
 * @remarks Requests are never retried. Callers validate identities and versions before writes.
 */
export const callApi = async <T>(
  path: string,
  query: Record<string, string>,
  signal?: AbortSignal,
  options: CallOptions = {}
): Promise<T> => {
  if (!process.env.CONTENTFUL_MANAGEMENT_TOKEN) {
    throw new Error(
      "Set CONTENTFUL_MANAGEMENT_TOKEN before using Contentful tools."
    );
  }
  const url = new URL(path, API_HOST);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url, {
    ...(!(options.body === undefined) && { body: options.body }),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${process.env.CONTENTFUL_MANAGEMENT_TOKEN}`,
      ...options.headers,
    },
    method: options.method ?? "GET",
    signal,
  });
  if (!res.ok) {
    let detail = "";
    try {
      // SAFETY: Contentful error-body inspection is best-effort; malformed JSON or nested fields are caught below.
      detail = describeApiError((await res.json()) as ApiErrorBody);
    } catch {
      // ignore non-JSON error bodies
    }
    throw new ContentfulApiError(
      res.status,
      `Contentful API returned ${res.status}${detail ? ` (${detail})` : ""}.${STATUS_HINTS.get(res.status) ?? ""}`
    );
  }
  if (res.status === 204) {
    // SAFETY: Only the verified HTTP 204 branch returns no body; callers of no-content endpoints use T = void.
    return undefined as T;
  }
  // SAFETY: The CMA transport preserves the caller-selected response contract; callers validate identities and versions before writes.
  return (await res.json()) as T;
};
