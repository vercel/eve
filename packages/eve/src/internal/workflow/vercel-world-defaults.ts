/** Configure the freshly constructed built-in Vercel World before installation. */
export function applyVercelWorkflowWorldDefaults(
  world: { streamFlushIntervalMs?: number },
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): void {
  // Lifecycle events arrive across several async handlers; a short window lets
  // each burst share a network write. The SDK's explicit env override still wins.
  world.streamFlushIntervalMs ??= 10;

  // world-vercel reads this gate on every event write, so the default applies
  // even though it is set after construction. Operators opt out with `http`.
  if (env.WORKFLOW_EVENTS_TRANSPORT === undefined || env.WORKFLOW_EVENTS_TRANSPORT === "") {
    env.WORKFLOW_EVENTS_TRANSPORT = "ws";
  }
}
