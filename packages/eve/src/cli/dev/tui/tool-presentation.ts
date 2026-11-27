import { diffWriteDetail, type ToolDetailLine } from "./line-diff.js";
import { stripTerminalControls } from "#cli/ui/terminal-text.js";
import { displayName, displayTitle } from "#protocol/session-projection/display-name.js";
import { REPLY_TOOL_NAME } from "#protocol/reply-tool.js";
import { summarizeToolArgs, summarizeToolResult } from "./tool-format.js";

interface ToolPresentation {
  readonly title: string;
  readonly subtitle: string;
  readonly summarizeResult: (output: unknown) => string | undefined;
  readonly group?: ToolGroupPresentation;
  readonly doneTitle?: string;
  readonly detail?: readonly ToolDetailLine[];
  readonly keepDetailWhenDone?: boolean;
}

export interface ToolPresentationContext {
  readonly previousContent?: string;
  readonly existed?: boolean;
  readonly isSubagent?: boolean;
  readonly label?: string;
  readonly completeLabel?: string;
}

export interface ToolGroupPresentation {
  readonly verb: string;
  readonly pastVerb: string;
  readonly singularNoun: string;
  readonly pluralNoun: string;
  readonly item: string;
}

interface BuiltinToolCopy {
  readonly verb: string;
  readonly pastVerb: string;
  readonly argKey: string;
  readonly extractItem?: (input: unknown) => string | undefined;
  readonly singularNoun: string;
  readonly pluralNoun: string;
}

const WRITE_FILE_VERB = "Write";
const DELEGATE_VERB = "Delegate";
const REPLY_TITLE = "Reply";

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
    argKey: "question",
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
    extractItem: (input) =>
      salientArg(input, "objective") ??
      salientArg(input, "search_query") ??
      salientArg(input, "searchQuery") ??
      webSearchActionArg(input),
    singularNoun: "query",
    pluralNoun: "queries",
  },
};

function presentWriteFileTool(
  toolName: string,
  input: unknown,
  context: ToolPresentationContext | undefined,
): ToolPresentation {
  const write = readWriteFileInput(toolName, input);
  if (write === undefined) {
    return {
      title: toolDisplayTitle(toolName),
      subtitle: summarizeToolArgs(input),
      summarizeResult: summarizeToolResult,
    };
  }

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

export function presentTool(
  toolName: string,
  input: unknown,
  context?: ToolPresentationContext,
): ToolPresentation {
  const baseName = toolBaseName(toolName);
  if (baseName === "write_file") return presentWriteFileTool(toolName, input, context);
  if (context?.isSubagent === true) {
    const name = isSelfModificationAgent(toolName)
      ? agentDisplayName(toolName)
      : agentTaskLabel(agentDisplayName(toolName));
    return {
      title: `${DELEGATE_VERB} ${name}`,
      doneTitle: `Delegated ${name}`,
      subtitle: salientArg(input, "message") ?? "",
      summarizeResult: () => undefined,
    };
  }
  if (baseName === REPLY_TOOL_NAME) {
    return { title: REPLY_TITLE, subtitle: "", summarizeResult: () => undefined };
  }

  const copy = BUILTIN_TOOL_COPY[baseName];
  if (copy !== undefined) {
    const item = salientArg(input, copy.argKey) ?? copy.extractItem?.(input);
    if (item !== undefined) {
      return {
        title: `${copy.verb} ${item}`,
        doneTitle: `${copy.pastVerb} ${item}`,
        subtitle: "",
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

  if (context?.label !== undefined) {
    const presentation = {
      title: context.label,
      subtitle: "",
      summarizeResult: summarizeToolResult,
    };
    return context.completeLabel === undefined
      ? presentation
      : { ...presentation, doneTitle: context.completeLabel };
  }

  return {
    title: toolDisplayTitle(toolName),
    subtitle: summarizeToolArgs(input),
    summarizeResult: summarizeToolResult,
  };
}

export function toolDisplayTitle(toolName: string): string {
  return displayTitle(toolBaseName(toolName));
}

export const SELF_MODIFICATION_AGENT_NAME = "self__modify";

const AGENT_DISPLAY_NAMES: ReadonlyMap<string, string> = new Map([
  ["agent", "subagent"],
  [SELF_MODIFICATION_AGENT_NAME, "agent editor"],
]);

export function isSelfModificationAgent(toolName: string): boolean {
  return toolBaseName(toolName) === SELF_MODIFICATION_AGENT_NAME;
}

export function agentTaskLabel(name: string): string {
  return /^subagent(?::\d+)?$/u.test(name) || name.startsWith("agent editor")
    ? name
    : `subagent(${name})`;
}

export function agentDisplayName(toolName: string): string {
  const baseName = toolBaseName(toolName);
  return AGENT_DISPLAY_NAMES.get(baseName) ?? displayName(baseName.replace(/(?<=.)__agent$/u, ""));
}

export function presentPreparingTool(
  toolName: string,
  context?: ToolPresentationContext,
): ToolPresentation {
  const baseName = toolBaseName(toolName);
  if (baseName === REPLY_TOOL_NAME) {
    return { title: REPLY_TITLE, subtitle: "", summarizeResult: () => undefined };
  }
  if (context?.isSubagent === true) {
    return {
      title: `${DELEGATE_VERB} ${agentTaskLabel(agentDisplayName(toolName))} …`,
      subtitle: "",
      summarizeResult: () => undefined,
    };
  }
  const verb = baseName === "write_file" ? WRITE_FILE_VERB : BUILTIN_TOOL_COPY[baseName]?.verb;
  return {
    title: `${verb ?? toolDisplayTitle(toolName)} …`,
    subtitle: "",
    summarizeResult: () => undefined,
  };
}

export function isPanelRoutedTool(toolName: string): boolean {
  return toolBaseName(toolName) === "ask_question";
}

export function toolBaseName(toolName: string): string {
  return toolName.split(/[.:/]/u).at(-1) ?? toolName;
}

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

function salientArg(input: unknown, key: string): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== "string") return undefined;
  return salientLine(value);
}

function salientLine(value: string): string | undefined {
  const line = stripTerminalControls(value)
    .split(/\r?\n/u)
    .find((candidate) => candidate.trim().length > 0);
  const trimmed = line?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
}
