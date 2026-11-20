import { stripTerminalControls } from "#cli/ui/terminal-text.js";

const ELLIPSIS = "…";

export function summarizeToolArgs(input: unknown, maxLength = 80): string {
  if (input === undefined || input === null) {
    return "";
  }

  if (typeof input !== "object") {
    return truncate(formatScalar(input), maxLength);
  }

  if (Array.isArray(input)) {
    return truncate(`[${input.length}]`, maxLength);
  }

  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) {
    return "";
  }

  const parts: string[] = [];
  for (const [key, value] of entries) {
    parts.push(`${stripTerminalControls(key)}=${formatInlineValue(value)}`);
  }

  return truncate(parts.join("  "), maxLength);
}

export function summarizeToolResult(output: unknown, maxLength = 80): string {
  if (output === undefined || output === null) {
    return "";
  }

  if (typeof output === "string") {
    const firstLine = output.split("\n").find((line) => line.trim().length > 0) ?? "";
    return truncate(firstLine.trim(), maxLength);
  }

  if (typeof output !== "object") {
    return truncate(formatScalar(output), maxLength);
  }

  if (Array.isArray(output)) {
    return truncate(`${output.length} ${output.length === 1 ? "item" : "items"}`, maxLength);
  }

  const record = output as Record<string, unknown>;
  for (const key of ["result", "text", "message", "summary", "value", "output"]) {
    const value = record[key];
    if (value !== undefined && typeof value !== "object") {
      return truncate(`${formatScalar(value)}`, maxLength);
    }
  }

  const keys = Object.keys(record);
  if (keys.length === 0) {
    return "{}";
  }

  const inline = keys
    .slice(0, 3)
    .map((key) => `${key}=${formatInlineValue(record[key])}`)
    .join("  ");
  return truncate(keys.length > 3 ? `${inline}  ${ELLIPSIS}` : inline, maxLength);
}

export function formatValuePretty(value: unknown): string {
  if (typeof value === "string") {
    return stripTerminalControls(value);
  }

  try {
    return stripTerminalControls(JSON.stringify(value, null, 2) ?? String(value));
  } catch {
    return stripTerminalControls(String(value));
  }
}

function formatInlineValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return `"${truncate(value, 32)}"`;
  if (typeof value === "object") {
    return Array.isArray(value) ? `[${value.length}]` : "{…}";
  }
  return formatScalar(value);
}

function formatScalar(value: unknown): string {
  if (typeof value === "string") return stripTerminalControls(value);
  return stripTerminalControls(String(value));
}

export function truncate(text: string, maxLength: number): string {
  const collapsed = stripTerminalControls(text).replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}${ELLIPSIS}`;
}
