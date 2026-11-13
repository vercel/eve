import "server-only";

/**
 * Server-side access to the private FastAPI service, for Server Components,
 * Server Actions, and route handlers. URL resolution and `BackendError` are
 * shared with the agent's client; errors here carry FastAPI's `detail` as a
 * user-facing message.
 */
import { BackendError, backendUrl } from "../../../agent/lib/backend";

export { BackendError, backendUrl };
export type { Task } from "../../../agent/lib/tasks";

/** Calls FastAPI and returns the parsed JSON body (`undefined` for 204 responses). */
export async function backendJson<T>(
  path: string,
  init: Omit<RequestInit, "body"> & { json?: unknown } = {},
): Promise<T> {
  const { json, headers, ...rest } = init;
  const response = await fetch(backendUrl(path), {
    cache: "no-store",
    ...rest,
    headers: {
      accept: "application/json",
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });

  if (!response.ok) {
    throw new BackendError(await errorDetail(response), response.status);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") {
      return body.detail;
    }
    if (Array.isArray(body.detail)) {
      // FastAPI validation errors: [{ loc, msg, ... }]
      return body.detail.map((item: { msg?: string }) => item.msg ?? "Invalid input").join("; ");
    }
  } catch {
    // Not JSON; fall through.
  }
  return `FastAPI returned ${response.status}`;
}

export type ServiceInfo = {
  service: string;
  python_version: string;
  fastapi_version: string;
  environment: string;
  region: string | null;
  deployment_url: string | null;
};
