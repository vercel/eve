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
    const url = stringField(input, "url");
    if (url !== undefined) {
      return {
        title: `Fetch ${url}`,
        subtitle: "",
        summarizeResult: () => undefined,
        group: { verb: "Fetch", singularNoun: "URL", pluralNoun: "URLs", item: url },
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
