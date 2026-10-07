/** Configure the freshly constructed built-in Vercel World before installation. */
export function applyVercelWorkflowWorldDefaults(
  world: { streamFlushIntervalMs?: number },
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): void {
  // Lifecycle events arrive across several async handlers; a short window lets
  // each burst share a network write. The SDK's explicit env override still wins.
  world.streamFlushIntervalMs ??= 10;

  // The server accepts or declines this capability and world-vercel falls back to HTTP.
  if (env.WORKFLOW_STREAMS_TRANSPORT === undefined || env.WORKFLOW_STREAMS_TRANSPORT === "") {
    env.WORKFLOW_STREAMS_TRANSPORT = "ws";
  }
}
