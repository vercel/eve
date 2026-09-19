import { MAX_ACTIVITY_TEXT_LENGTH } from "#shared/presentation-text.js";

interface ToolLabelOptions {
  readonly detailStyle?: "inline-code";
}

export function toolLabel(verb: string, value: unknown, options?: ToolLabelOptions): string {
  if (typeof value !== "string" && typeof value !== "number") return verb;
  const detail = String(value).trim();
  if (detail === "") return verb;
  if (options?.detailStyle !== "inline-code" || detail.includes("`")) return `${verb} ${detail}`;
  const available = MAX_ACTIVITY_TEXT_LENGTH - verb.length - 3;
  return `${verb} \`${detail.slice(0, available)}\``;
}
