export interface DefaultModule {
  readonly logicalPath: string;
  readonly semanticRevision?: string;
  readonly loadNamespace: () => Promise<Record<string, unknown>>;
}

export const DEFAULT_TOOLS = [
  "bash",
  "read_file",
  "write_file",
  "edit_file",
  "web_fetch",
  "web_search",
] as const;
export type DefaultToolName = (typeof DEFAULT_TOOLS)[number];

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
