/**
 * Formats tool-call inputs and outputs for the terminal UI.
 *
 * Two registers: a *compact* one-line summary used while streaming and once a
 * call resolves (`get_weather  city="San Francisco" → 73°F`), and a *full*
 * pretty-printed value used when the user opts into `--tools full`. Both are
 * plain strings — color is applied by the block renderer.
 */

import { stripTerminalControls } from "./terminal-text.js";

const ELLIPSIS = "…";

/**
 * Summarizes a tool's input as a compact, single-line `key=value` list.
 * Shallow object fields are shown inline; nested values collapse to a type
 * hint (`{…}`, `[3]`). Non-object inputs are rendered as a short literal.
 */
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

/**
 * Summarizes a tool's output as a compact, single-line result. Scalars render
 * directly; strings collapse to their first non-empty line; arrays and objects
 * collapse to a count / key hint.
 */
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
  // Prefer a human-meaningful scalar field if one is present.
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

/**
 * Pretty-prints a value across multiple lines for the expanded `--tools full`
 * view. Strings render directly; everything else is JSON with 2-space
 * indentation.
 */
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

/**
 * Truncates `text` to at most `maxLength` visible characters, appending an
 * ellipsis. Operates on plain text (no ANSI) by contract.
 */
export function truncate(text: string, maxLength: number): string {
  const collapsed = stripTerminalControls(text).replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}${ELLIPSIS}`;
}
