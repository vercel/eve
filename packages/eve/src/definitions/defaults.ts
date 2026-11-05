import {
  DEFAULT_TOOL_MODULES,
  DEFAULT_TOOLS,
  type DefaultToolName,
  SANDBOX_TOOLS,
} from "#framework/sources/default-tools.js";
import { codeSandbox, type CodeSandbox } from "#runtime/sandbox/code-sandbox.js";
import { JustBashSandbox } from "#sandbox/providers/just-bash.js";
import { withToolApproval } from "#tools/definition.js";
import {
  defaultWebSearch,
  resolveWebSearchActivityLabel,
  WEB_SEARCH_TOOL_DESCRIPTION,
} from "#tools/provided/web-search.js";
import { UNSPECIFIED_INPUT_SCHEMA } from "#tools/schema.js";
import type { Definition } from "./definition.js";
import { selfAgentToolDefinition } from "./delegation.js";
import { toolEntries, toolsDefinition } from "./tools.js";

// eve's defaults for an agent defined in code, from the list the compiler adds to file agents
// (`#framework/sources/default-tools.js`): the same tools, each under the file it would come from
// (`tools/bash.ts` -> `tool::bash`), the sandbox they run in under `sandbox.ts`'s id, and last the
// root's `agent` tool (`tools/agent.ts` -> `tool::agent`), as the compiler adds them.

/** A default tool a code agent can leave out: one of every node's, or the root's `agent`. */
export type CodeDefaultToolName = DefaultToolName | "agent";

/** The default tools that run code, so take an approval policy; `web_search` runs at the provider. */
export type ApprovableDefaultToolName = Exclude<DefaultToolName, "web_search">;

/** The tool a default tool's module exports. */
type DefaultTool<Name extends ApprovableDefaultToolName> = Awaited<
  ReturnType<(typeof DEFAULT_TOOL_MODULES)[Name]["loadNamespace"]>
>["default"];

/** The approval policies each default tool takes: one over its own input. */
export type DefaultToolApprovals = {
  readonly [Name in ApprovableDefaultToolName]?: DefaultTool<Name>["approval"];
};

export interface EveDefaultsOptions {
  /** Default tools to leave out. */
  readonly without?: readonly CodeDefaultToolName[];
  /**
   * The sandbox the bash and file tools run in: by default just-bash under
   * `<cwd>/.eve/sandbox-cache`, which needs no daemon or account.
   */
  readonly sandbox?: CodeSandbox;
  /** Approval policies by default tool, such as `{ bash: always(), write_file: always() }`. */
  readonly approval?: DefaultToolApprovals;
}

/** The session's sandbox, as `agent/sandbox.ts` would declare it: one resource, no contribution. */
export function sandboxDefinition(sandbox: CodeSandbox): Definition {
  return {
    contribute: () => ({}),
    id: "sandbox",
    label: "sandbox.ts",
    resources: { sandbox },
  };
}

/** eve's presets for an agent defined in code. */
export const eve = {
  /**
   * The default tools and the sandbox they run in, as definitions a code agent lists: the sandbox
   * only when a tool that runs in it is kept.
   */
  defaults(options: EveDefaultsOptions = {}): Definition[] {
    const without = new Set<CodeDefaultToolName>(options.without ?? []);
    const names = DEFAULT_TOOLS.filter((name) => !without.has(name));
    const definitions = names.map((name) => DEFAULT_TOOL_DEFINITIONS[name](options));
    if (!without.has("agent")) definitions.push(selfAgentToolDefinition);
    if (!names.some((name) => SANDBOX_TOOLS.has(name))) return definitions;
    const sandbox = options.sandbox ?? codeSandbox(JustBashSandbox.environment({}));
    return [sandboxDefinition(sandbox), ...definitions];
  },
} as const;

/** Each default tool's definition, as the compiler would make it from the file it stands for. */
const DEFAULT_TOOL_DEFINITIONS: {
  readonly [Name in DefaultToolName]: (options: EveDefaultsOptions) => Definition;
} = {
  bash: (options) => codedTool("bash", options.approval?.bash),
  edit_file: (options) => codedTool("edit_file", options.approval?.edit_file),
  read_file: (options) => codedTool("read_file", options.approval?.read_file),
  web_fetch: (options) => codedTool("web_fetch", options.approval?.web_fetch),
  web_search: () => webSearchDefinition,
  write_file: (options) => codedTool("write_file", options.approval?.write_file),
};

/** A default tool with code, loaded where it runs, under `approval` when one is given. */
function codedTool<Name extends ApprovableDefaultToolName>(
  name: Name,
  approval: DefaultTool<Name>["approval"],
): Definition {
  const module = DEFAULT_TOOL_MODULES[name];
  return toolsDefinition({ logicalPath: module.logicalPath, slug: name }, async () => {
    const tool = (await module.loadNamespace()).default;
    return approval === undefined ? tool : withToolApproval(tool, approval);
  });
}

/**
 * `web_search` runs at the model's provider, so it has no code to keep: it's the entry the
 * compiler makes from `tools/web_search.ts`'s `webSearch()`, under that file's id.
 */
const webSearchDefinition: Definition = {
  contribute: () => ({
    tools: () => ({
      entries: toolEntries(
        [
          {
            behavior: {
              availability: [],
              handling: { kind: "provider-tool", provider: defaultWebSearch.provider },
            },
            description: WEB_SEARCH_TOOL_DESCRIPTION,
            frameworkTool: true,
            inputSchema: UNSPECIFIED_INPUT_SCHEMA,
            label: { start: resolveWebSearchActivityLabel },
            name: "web_search",
          },
        ],
        "tool::web_search",
      ),
    }),
  }),
  id: "tool::web_search",
  label: "tools/web_search.ts",
};
