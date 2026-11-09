/** Configure the freshly constructed built-in Vercel World before installation. */
export function applyVercelWorkflowWorldDefaults(world: { streamFlushIntervalMs?: number }): void {
  // Lifecycle events arrive across several async handlers; a short window lets
  // each burst share a network write. The SDK's explicit env override still wins.
  world.streamFlushIntervalMs ??= 10;
}
