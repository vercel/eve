import { AgentInfoResultSchema, HealthResultSchema } from "eve/client";

export type ServerStatus = "checking" | "ready" | "auth-required" | "forbidden" | "unavailable";

// Reachability uses the small readiness response, not the full agent/tool manifest.
export async function probeServer(
  signal: AbortSignal,
  request: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<Exclude<ServerStatus, "checking">> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const deadline = controller.signal;
  const get = (path: string) =>
    request(path, { signal: deadline, cache: "no-store", redirect: "manual" });
  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await get("/eve/v1/health");
        if (response.status < 500 || attempt === 1) break;
        await response.body?.cancel();
      } catch (error) {
        if (deadline.aborted || attempt === 1 || !(error instanceof TypeError)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      deadline.throwIfAborted();
    }
    if (!response) return "unavailable";
    if (response.status === 401 || response.type === "opaqueredirect") return "auth-required";
    if (response.status === 403) return "forbidden";
    if (response.ok) {
      const data: unknown = await response.json().catch(() => undefined);
      if (HealthResultSchema.safeParse(data).success) return "ready";
    } else if (response.status !== 404) {
      return "unavailable";
    }
    const info = await get("/eve/v1/info");
    if (info.status === 401 || info.type === "opaqueredirect") return "auth-required";
    if (info.status === 403) return "forbidden";
    return info.ok && AgentInfoResultSchema.safeParse(await info.json()).success
      ? "ready"
      : "unavailable";
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

/** One in-flight check; outages keep polling and visibility changes cancel stale checks. */
export function createServerStatusMonitor({
  onStatus,
  isHidden,
  probe = probeServer,
  intervalMs = 10_000,
}: {
  onStatus: (status: ServerStatus) => void;
  isHidden: () => boolean;
  probe?: typeof probeServer;
  intervalMs?: number;
}) {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: AbortController | undefined;
  const check = async () => {
    if (disposed || isHidden() || active) return;
    clearTimeout(timer);
    const controller = new AbortController();
    active = controller;
    try {
      const result = await probe(controller.signal);
      if (!disposed && !controller.signal.aborted) onStatus(result);
    } finally {
      if (active === controller) {
        active = undefined;
        if (!disposed && !isHidden()) timer = setTimeout(check, intervalMs);
      }
    }
  };
  return {
    check,
    visibilityChanged() {
      if (isHidden()) {
        clearTimeout(timer);
        active?.abort();
        active = undefined;
      } else void check();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      active?.abort();
    },
  };
}
