/**
 * Minimal client for the private FastAPI service. `apps/web/lib/backend.ts`
 * reuses `backendUrl` and `BackendError`, so keep this module free of eve
 * runtime imports.
 *
 * On Vercel (and under `vercel dev --local`) the `api` service binding injects
 * BACKEND_URL. When running `eve dev` or `pnpm dev:web` on its own, it falls
 * back to the `pnpm dev:api` server on port 8000.
 */
const LOCAL_BACKEND_URL = "http://127.0.0.1:8000";

export class BackendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

type Query = Record<string, string | number | boolean | undefined>;

export type BackendRequest = {
  readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly body?: unknown;
  readonly query?: Query;
};

function backendBaseUrl(): string {
  const configured = process.env.BACKEND_URL?.trim();
  if (configured) {
    return configured.endsWith("/") ? configured : `${configured}/`;
  }
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "development") {
    throw new Error("BACKEND_URL is not set. Check the `api` binding in vercel.ts.");
  }
  return `${LOCAL_BACKEND_URL}/`;
}

/** Resolves a FastAPI path (with or without a leading slash) against BACKEND_URL. */
export function backendUrl(path: string): URL {
  return new URL(path.replace(/^\//, ""), backendBaseUrl());
}

/** Calls FastAPI and returns the parsed JSON body (`undefined` for 204 responses). */
export async function backendRequest<T>(path: string, request: BackendRequest = {}): Promise<T> {
  const url = backendUrl(path);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const hasBody = request.body !== undefined;
  const response = await fetch(url, {
    method: request.method ?? (hasBody ? "POST" : "GET"),
    headers: {
      accept: "application/json",
      ...(hasBody ? { "content-type": "application/json" } : {}),
    },
    body: hasBody ? JSON.stringify(request.body) : undefined,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new BackendError(
      `FastAPI ${path} returned ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
      response.status,
    );
  }

  return (response.status === 204 ? undefined : await response.json()) as T;
}
