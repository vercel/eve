// The default tools every agent gets unless it says otherwise, by name, as one list: the compiler
// adds their modules to each file agent's node (`registry.ts`).

/** A default module: the agent file it stands in for, and its code. */
export interface DefaultModule {
  readonly logicalPath: string;
  readonly semanticRevision?: string;
  readonly loadNamespace: () => Promise<Record<string, unknown>>;
}

/** The default tools, by name, in the order every agent lists them. */
export const DEFAULT_TOOLS = [
  "bash",
  "read_file",
  "write_file",
  "edit_file",
  "web_fetch",
  "web_search",
] as const;
export type DefaultToolName = (typeof DEFAULT_TOOLS)[number];

/** The default tools that run in the session's sandbox. */
export const SANDBOX_TOOLS: ReadonlySet<DefaultToolName> = new Set([
  "bash",
  "read_file",
  "write_file",
  "edit_file",
]);

/** Each default tool's module, typed by what it exports. */
export const DEFAULT_TOOL_MODULES = {
  bash: { logicalPath: "tools/bash.ts", loadNamespace: () => import("#tools/provided/bash.js") },
  read_file: {
    logicalPath: "tools/read_file.ts",
    loadNamespace: () => import("#tools/provided/read-file.js"),
  },
  write_file: {
    logicalPath: "tools/write_file.ts",
    loadNamespace: () => import("#tools/provided/write-file.js"),
  },
  edit_file: {
    logicalPath: "tools/edit_file.ts",
    loadNamespace: () => import("#tools/provided/edit-file.js"),
  },
  web_fetch: {
    logicalPath: "tools/web_fetch.ts",
    loadNamespace: () => import("#tools/provided/web-fetch.js"),
  },
  web_search: {
    logicalPath: "tools/web_search.ts",
    loadNamespace: () => import("#tools/provided/web-search.js"),
  },
} as const satisfies Readonly<Record<DefaultToolName, DefaultModule>>;
