const LOCAL_WORKFLOW_DELIVERY_TIMEOUT_ENV_NAMES = [
  "WORKFLOW_LOCAL_BODY_TIMEOUT_MS",
  "WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS",
] as const;

export function applyLocalWorkflowWorldDeliveryTimeoutDefaults(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): void {
  for (const name of LOCAL_WORKFLOW_DELIVERY_TIMEOUT_ENV_NAMES) {
    if (env[name] === undefined || env[name] === "") {
      env[name] = "0";
    }
  }
}
