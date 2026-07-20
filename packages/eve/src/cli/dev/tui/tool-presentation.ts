import { diffWriteDetail, type ToolDetailLine } from "./line-diff.js";
import { stripTerminalControls } from "#cli/ui/terminal-text.js";
import { summarizeToolArgs, summarizeToolResult } from "./tool-format.js";

/** Renderer-ready copy derived from a tool call without owning its lifecycle. */
export interface ToolPresentation {
  readonly title: string;
  readonly subtitle: string;
  readonly summarizeResult: (output: unknown) => string | undefined;
  readonly group?: ToolGroupPresentation;
  /** Past-tense title used once the call settles successfully. */
  readonly doneTitle?: string;
  /** Salient body lines shown behind the `│` rail under the header. */
  readonly detail?: readonly ToolDetailLine[];
  /** When true, `detail` stays visible after the call settles (writes). */
  readonly keepDetailWhenDone?: boolean;
}

/**
 * Renderer-owned knowledge a presentation may fold in: what a write replaced
 * (from the session's file-content cache) and whether the file existed (from
 * the call's result, once it arrives).
 */
export interface ToolPresentationContext {
  readonly previousContent?: string;
  readonly existed?: boolean;
  /**
   * True when the tool dispatches a named subagent (each subagent exposes a
   * tool bearing its own name). The presentation reads as a delegation —
   * `Delegate stock-price` — instead of a generic tool call.
   */
  readonly isSubagent?: boolean;
}

/** Copy needed to aggregate equivalent calls without merging their state. */
export interface ToolGroupPresentation {
  readonly verb: string;
  readonly pastVerb: string;
  readonly singularNoun: string;
  readonly pluralNoun: string;
  readonly item: string;
}

/** Semantic activity copy for one builtin tool with a single telling argument. */
interface BuiltinToolCopy {
  readonly verb: string;
  readonly pastVerb: string;
  readonly argKey: string;
  /**
   * Tool-specific extraction for provider-managed input shapes the plain
   * `argKey` lookup can't reach (alternate key names, nested objects).
   * Runs after `argKey` misses.
   */
  readonly extractItem?: (input: unknown) => string | undefined;
  readonly singularNoun: string;
  readonly pluralNoun: string;
}

/** Copy shared by the full presenters and their preparing placeholders. */
const WRITE_FILE_VERB = "Write";
const DELEGATE_VERB = "Delegate";
const FINAL_OUTPUT_TITLE = "Return final output";

/**
 * Builtin tools whose calls read as one verb plus one argument. Runs group
 * by tool name; equal copy across two tools only merges their entries in a
 * completed section's counted summary, which reads fine.
 */
const BUILTIN_TOOL_COPY: Readonly<Record<string, BuiltinToolCopy>> = {
  agent: {
    verb: "Delegate",
    pastVerb: "Delegated",
    argKey: "message",
    singularNoun: "task",
    pluralNoun: "tasks",
  },
  ask_question: {
    verb: "Ask",
    pastVerb: "Asked",
    argKey: "prompt",
    singularNoun: "question",
    pluralNoun: "questions",
  },
  bash: {
    verb: "Run",
    pastVerb: "Ran",
    argKey: "command",
    singularNoun: "command",
    pluralNoun: "commands",
  },
  connection_search: {
    verb: "Discover",
    pastVerb: "Discovered",
    argKey: "keywords",
    singularNoun: "tool search",
    pluralNoun: "tool searches",
  },
  glob: {
    verb: "Glob",
    pastVerb: "Globbed",
    argKey: "pattern",
    singularNoun: "pattern",
    pluralNoun: "patterns",
  },
  grep: {
    verb: "Grep",
    pastVerb: "Grepped",
    argKey: "pattern",
    singularNoun: "pattern",
    pluralNoun: "patterns",
  },
  load_skill: {
    verb: "Load",
    pastVerb: "Loaded",
    argKey: "skill",
    singularNoun: "skill",
    pluralNoun: "skills",
  },
  read_file: {
    verb: "Read",
    pastVerb: "Read",
    argKey: "filePath",
    singularNoun: "file",
    pluralNoun: "files",
  },
  web_fetch: {
    verb: "Fetch",
    pastVerb: "Fetched",
    argKey: "url",
    singularNoun: "URL",
    pluralNoun: "URLs",
  },
  web_search: {
    verb: "Search",
    pastVerb: "Searched",
    argKey: "query",
    // Provider-managed variants disagree on the argument shape: some send
    // an `objective`/`search_query` pair instead of Anthropic's `query`,
    // and OpenAI nests it under `action`.
    extractItem: (input) =>
      salientArg(input, "objective") ??
      salientArg(input, "search_query") ??
      salientArg(input, "searchQuery") ??
      webSearchActionArg(input),
    singularNoun: "query",
    pluralNoun: "queries",
  },
};

/**
 * A write is never aggregated: each written file keeps its own block, and the
 * written content stays visible after the call settles — the change itself is
 * the story, unlike other builtin outputs. Lines arrive uncapped; the block
 * renderer windows them so a large generated file cannot flood the transcript.
 */
function presentWriteFileTool(
  toolName: string,
  input: unknown,
  context: ToolPresentationContext | undefined,
): ToolPresentation {
  const write = readWriteFileInput(toolName, input);
  if (write === undefined) {
    return {
      title: toolName,
      subtitle: summarizeToolArgs(input),
      summarizeResult: summarizeToolResult,
    };
  }

  // Diff on raw content; model-controlled text loses its terminal controls
  // only at the display boundary so the comparison stays exact.
  const detail = diffWriteDetail(context?.previousContent, write.content, context?.existed).map(
    (line) => (line.kind === "gap" ? line : { ...line, text: stripTerminalControls(line.text) }),
  );

  return {
    title: `${WRITE_FILE_VERB} ${salientLine(write.path) ?? write.path}`,
    doneTitle: `Wrote ${salientLine(write.path) ?? write.path}`,
    subtitle: "",
    summarizeResult: () => undefined,
    detail,
    keepDetailWhenDone: true,
  };
}

/**
 * Extracts a write tool call's full-replacement payload. Exported so the
 * renderer can feed its file-content cache from the same contract the
 * presentation reads.
 */
export function readWriteFileInput(
  toolName: string,
  input: unknown,
): { path: string; content: string } | undefined {
  if (toolBaseName(toolName) !== "write_file") return undefined;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const path = record["filePath"];
  const content = record["content"];
  if (typeof path !== "string" || path.trim().length === 0) return undefined;
  if (typeof content !== "string") return undefined;
  return { path, content };
}

/**
 * Turns known tool contracts into concise activity copy. Unknown or malformed
 * calls keep the generic formatter, so presentation can never break execution.
 */
export function presentTool(
  toolName: string,
  input: unknown,
  context?: ToolPresentationContext,
): ToolPresentation {
  const baseName = toolBaseName(toolName);
  if (baseName === "todo") return presentTodoTool(input);
  if (baseName === "write_file") return presentWriteFileTool(toolName, input, context);
  if (context?.isSubagent === true) {
    // Named subagent dispatch: the tool name is the delegation target; the
    // message rides as the quiet subtitle. The block is transient — the
    // nested subagent section replaces it once the child registers.
    return {
      title: `${DELEGATE_VERB} ${baseName}`,
      doneTitle: `Delegated ${baseName}`,
      subtitle: salientArg(input, "message") ?? "",
      summarizeResult: () => undefined,
    };
  }
  if (baseName === "final_output") {
    // Task-mode terminal signal (subagent streams): its input is the
    // structured result itself, kept behind the expanded `--tools full` view.
    return { title: FINAL_OUTPUT_TITLE, subtitle: "", summarizeResult: () => undefined };
  }

  const copy = BUILTIN_TOOL_COPY[baseName];
  if (copy !== undefined) {
    const item = salientArg(input, copy.argKey) ?? copy.extractItem?.(input);
    if (item !== undefined) {
      return {
        title: `${copy.verb} ${item}`,
        doneTitle: `${copy.pastVerb} ${item}`,
        subtitle: "",
        // The salient argument is the story; builtin outputs (page content,
        // file bodies, stdout) stay behind the expanded `--tools full` view.
        summarizeResult: () => undefined,
        group: {
          verb: copy.verb,
          pastVerb: copy.pastVerb,
          singularNoun: copy.singularNoun,
          pluralNoun: copy.pluralNoun,
          item,
        },
      };
    }
  }

  return {
    title: toolName,
    subtitle: summarizeToolArgs(input),
    summarizeResult: summarizeToolResult,
  };
}

/**
 * Placeholder copy for a call whose input is still streaming from the model
 * (`action.preparing`). Known tools lead with their activity verb so the row
 * already reads as intent (`Fetch …`); unknown tools keep their name with a
 * quiet hint. The full presentation replaces this once the input arrives.
 */
export function presentPreparingTool(
  toolName: string,
  context?: ToolPresentationContext,
): ToolPresentation {
  const baseName = toolBaseName(toolName);
  if (baseName === "final_output") {
    return { title: FINAL_OUTPUT_TITLE, subtitle: "", summarizeResult: () => undefined };
  }
  if (context?.isSubagent === true) {
    // A named subagent's tool carries the delegation target in its name —
    // showable before the message finishes streaming.
    return {
      title: `${DELEGATE_VERB} ${baseName} …`,
      subtitle: "",
      summarizeResult: () => undefined,
    };
  }
  const verb = baseName === "write_file" ? WRITE_FILE_VERB : BUILTIN_TOOL_COPY[baseName]?.verb;
  return {
    title: verb === undefined ? toolName : `${verb} …`,
    subtitle: verb === undefined ? "preparing…" : "",
    summarizeResult: () => undefined,
  };
}

/**
 * Tools whose whole story renders through a dedicated surface — the pinned
 * todo panel, the question overlay — instead of a transcript tool block.
 * Both the preparing announcement and the full call must agree on this
 * set, or a panel-routed tool ghosts as a preparing block.
 */
export function isPanelRoutedTool(toolName: string): boolean {
  const baseName = toolBaseName(toolName);
  return baseName === "todo" || baseName === "ask_question";
}

/** The tool's short name with any connection/server namespace stripped. */
export function toolBaseName(toolName: string): string {
  return toolName.split(/[.:/]/u).at(-1) ?? toolName;
}

/**
 * `todo` writes the whole list (or reads it when `todos` is omitted), so its
 * call reads as list maintenance, not as one salient argument. The list body
 * stays behind the expanded `--tools full` view, like other builtin outputs.
 */
function presentTodoTool(input: unknown): ToolPresentation {
  const todos =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)["todos"]
      : undefined;
  if (!Array.isArray(todos)) {
    return { title: "Read todo list", subtitle: "", summarizeResult: () => undefined };
  }
  return {
    title: "Update todo list",
    subtitle: `${todos.length} task${todos.length === 1 ? "" : "s"}`,
    summarizeResult: () => undefined,
  };
}

/**
 * OpenAI's provider-managed web search nests its argument under `action`
 * (`search` carries `query`/`queries`, `openPage` a `url`, `findInPage` a
 * `pattern`); Anthropic's sends a top-level `query`, which the plain
 * `argKey` lookup already covers.
 */
function webSearchActionArg(input: unknown): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const action = (input as Record<string, unknown>)["action"];
  if (action === null || typeof action !== "object" || Array.isArray(action)) return undefined;
  const record = action as Record<string, unknown>;
  const queries = record["queries"];
  if (Array.isArray(queries)) {
    const items = queries.filter((query) => typeof query === "string").map(salientLine);
    const joined = items.filter((item) => item !== undefined).join(", ");
    if (joined.length > 0) return joined;
  }
  for (const key of ["query", "url", "pattern"]) {
    const value = record[key];
    if (typeof value === "string") {
      const line = salientLine(value);
      if (line !== undefined) return line;
    }
  }
  return undefined;
}

/**
 * The one argument worth rendering, reduced to a single safe line. `group.item`
 * renders verbatim in aggregated rows, so a model-controlled value must lose
 * its terminal controls here, not at the render call sites.
 */
function salientArg(input: unknown, key: string): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== "string") return undefined;
  return salientLine(value);
}

/** Reduces a model-controlled string to its first non-empty, control-free line. */
function salientLine(value: string): string | undefined {
  const line = stripTerminalControls(value)
    .split(/\r?\n/u)
    .find((candidate) => candidate.trim().length > 0);
  const trimmed = line?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
}
