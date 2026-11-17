export function applyVercelWorkflowWorldDefaults(world: { streamFlushIntervalMs?: number }): void {
  world.streamFlushIntervalMs ??= 10;
}
