/** Every supported captured-output filter, in CLI help order. */
export const LOG_DISPLAY_MODES = ["all", "stderr", "sandbox", "none"] as const;

export type LogDisplayMode = (typeof LOG_DISPLAY_MODES)[number];

/**
 * Order the dev TUI's Ctrl+L shortcut steps through {@link LogDisplayMode}
 * values, starting from `none`: each press reveals the next view and wraps
 * back to `none`.
 */
export const LOG_DISPLAY_MODE_CYCLE = [
  "none",
  "all",
  "stderr",
  "sandbox",
] as const satisfies readonly LogDisplayMode[];

/** Parses one CLI or `/loglevel` argument into a supported display mode. */
export function parseLogDisplayMode(value: string): LogDisplayMode | undefined {
  return LOG_DISPLAY_MODES.find((mode) => mode === value);
}

/** The mode after `current` in the Ctrl+L cycle, wrapping at the end. */
export function nextLogDisplayMode(current: LogDisplayMode): LogDisplayMode {
  const index = LOG_DISPLAY_MODE_CYCLE.indexOf(current);
  return LOG_DISPLAY_MODE_CYCLE[(index + 1) % LOG_DISPLAY_MODE_CYCLE.length] ?? "none";
}
