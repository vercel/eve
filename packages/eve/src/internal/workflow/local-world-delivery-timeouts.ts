const LOCAL_WORKFLOW_DELIVERY_TIMEOUT_ENV_NAMES = [
  "WORKFLOW_LOCAL_BODY_TIMEOUT_MS",
  "WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS",
] as const;

/**
 * Disables world-local's delivery deadlines unless the operator supplied an
 * override. world-local snapshots these values when `createWorld()` constructs
 * its queue and supports `0` as an unbounded timeout. Without this default, a
 * long inline turn can be retried while its original provider call is active.
 */
export function applyLocalWorkflowWorldDeliveryTimeoutDefaults(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): void {
  for (const name of LOCAL_WORKFLOW_DELIVERY_TIMEOUT_ENV_NAMES) {
    if (env[name] === undefined || env[name] === "") {
      env[name] = "0";
    }
  }
}
