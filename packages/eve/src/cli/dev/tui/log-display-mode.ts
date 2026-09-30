import type { LogLevel } from "#internal/logging.js";

export const LOG_DISPLAY_MODES = ["none", "error", "warn", "debug", "all"] as const;
export type LogDisplayMode = (typeof LOG_DISPLAY_MODES)[number];
export const LOG_DISPLAY_MODE_CYCLE = ["none", "error", "warn", "debug", "all"] as const;

export function parseLogDisplayMode(value: string): LogDisplayMode | undefined {
  return LOG_DISPLAY_MODES.find((mode) => mode === value);
}

export function nextLogDisplayMode(current: LogDisplayMode): LogDisplayMode {
  const index = LOG_DISPLAY_MODE_CYCLE.indexOf(current);
  return LOG_DISPLAY_MODE_CYCLE[(index + 1) % LOG_DISPLAY_MODE_CYCLE.length] ?? "none";
}

export function isLogVisible(mode: LogDisplayMode, source: string, level?: LogLevel): boolean {
  if (mode === "none") return false;
  if (mode === "all") return true;
  if (level === "error" || (level === undefined && source === "stderr")) return true;
  if (mode === "debug") return level !== undefined;
  return mode === "warn" && level === "warn";
}
