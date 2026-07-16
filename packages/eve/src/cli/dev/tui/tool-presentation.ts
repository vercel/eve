import { stripTerminalControls } from "./terminal-text.js";
import { summarizeToolArgs, summarizeToolResult } from "./tool-format.js";

/** Renderer-ready copy derived from a tool call without owning its lifecycle. */
export interface ToolPresentation {
  readonly title: string;
  readonly subtitle: string;
  readonly summarizeResult: (output: unknown) => string | undefined;
  readonly group?: ToolGroupPresentation;
}

/** Copy needed to aggregate equivalent calls without merging their state. */
export interface ToolGroupPresentation {
  readonly verb: string;
  readonly singularNoun: string;
  readonly pluralNoun: string;
  readonly item: string;
}

/**
 * Turns known tool contracts into concise activity copy. Unknown or malformed
 * calls keep the generic formatter, so presentation can never break execution.
 */
export function presentTool(toolName: string, input: unknown): ToolPresentation {
  if (toolBaseName(toolName) === "web_fetch") {
    // `group.item` renders verbatim in aggregated rows, so a model-controlled
    // URL must lose its terminal controls here, not at the render call sites.
    const url = stringField(input, "url");
    const safeUrl = url === undefined ? undefined : stripTerminalControls(url);
    if (safeUrl !== undefined && safeUrl.length > 0) {
      return {
        title: `Fetch ${safeUrl}`,
        subtitle: "",
        summarizeResult: () => undefined,
        group: { verb: "Fetch", singularNoun: "URL", pluralNoun: "URLs", item: safeUrl },
      };
    }
  }

  return {
    title: toolName,
    subtitle: summarizeToolArgs(input),
    summarizeResult: summarizeToolResult,
  };
}

function toolBaseName(toolName: string): string {
  return toolName.split(/[.:/]/u).at(-1) ?? toolName;
}

function stringField(input: unknown, key: string): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
