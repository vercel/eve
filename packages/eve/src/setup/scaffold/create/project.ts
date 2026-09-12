import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { PackageManagerKind } from "../../package-manager.js";
import { pinnedNodeEngineMajor } from "../../node-engine.js";
import type { AgentReasoningDefinition } from "../../../shared/agent-definition.js";
import { parseChatGptModelSelection } from "../../../shared/chatgpt-model.js";
import { SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS } from "../update/module-files.js";
import { pathExists, writeTextFile } from "../files.js";
import { blockingCreateInPlaceEntries } from "../create-in-place.js";
import { resolveVersionToken } from "../version-tokens.js";
import {
  applyPackageManagerWorkspaceConfiguration,
  isPackageManagerWorkspaceMember,
  patchWorkspaceRootPackageJson,
  type WorkspaceRootMutation,
} from "../workspace-root.js";
import { WEB_APP_TEMPLATE_FILES } from "./web-template.js";

export const CURRENT_DIRECTORY_PROJECT_NAME = ".";

export const DEFAULT_AI_PACKAGE_VERSION = "__AI_SDK_VERSION__";
export const DEFAULT_CONNECT_PACKAGE_VERSION = "__VERCEL_CONNECT_VERSION__";
export const DEFAULT_ZOD_PACKAGE_VERSION = "__ZOD_VERSION__";
const DEFAULT_TYPESCRIPT_PACKAGE_VERSION = "__TYPESCRIPT_VERSION__";

/**
 * The eve package metadata that generated projects consume together. Keeping
 * the dependency version and Node.js requirement in one value prevents a
 * scaffold from installing one eve release while declaring another release's
 * runtime contract.
 */
export interface EvePackageContract {
  /** eve dependency version or npm specifier written to the generated package. */
  version: string;
  /** The matching eve release's authored `package.json` `engines.node` value. */
  nodeEngine: string;
}

export const DEFAULT_EVE_PACKAGE_CONTRACT: EvePackageContract = {
  version: "__EVE_PACKAGE_DEPENDENCY_VERSION__",
  nodeEngine: "__NODE_ENGINE__",
};

/** Resolves a stamped or explicitly supplied eve package contract. */
export function resolveEvePackageContract(
  contract: EvePackageContract = DEFAULT_EVE_PACKAGE_CONTRACT,
): EvePackageContract {
  return {
    version: resolveVersionToken("evePackage.version", contract.version),
    nodeEngine: resolveVersionToken("evePackage.nodeEngine", contract.nodeEngine),
  };
}

interface TemplateContext {
  appName: string;
  model: string;
  reasoning?: AgentReasoningDefinition;
  eveVersion: string;
  aiPackageVersion: string;
  connectPackageVersion: string;
  zodPackageVersion: string;
  typescriptPackageVersion: string;
  nodeTypesVersion: string;
  nodeEngine: string;
}

/**
 * Provider slug a gateway model id routes through: the segment before the
 * first "/" (e.g. `anthropic/claude-sonnet-5` → `anthropic`). The slug is
 * injected into generated source, so characters outside the catalog's slug
 * alphabet are dropped; an id without a usable prefix falls back to
 * `anthropic`.
 */
export function modelProviderSlug(modelId: string): string {
  const provider = (modelId.split("/")[0] ?? "").replaceAll(/[^A-Za-z0-9._-]/gu, "");
  return provider.length > 0 ? provider : "anthropic";
}

/**
 * Env var the byok scaffold reads the provider API key from, derived from the
 * model's provider slug (e.g. `anthropic/...` → `ANTHROPIC_API_KEY`). The name
 * is the scaffold's convention: the key is passed to the gateway `byok` block
 * explicitly, so users can rename it freely. Non-alphanumerics fold to `_`
 * and a leading digit is prefixed, keeping `process.env.<name>` valid source.
 */
export function byokProviderEnvVar(modelId: string): string {
  const name = modelProviderSlug(modelId)
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/gu, "_");
  return `${/^[0-9]/.test(name) ? "_" : ""}${name}_API_KEY`;
}

/**
 * The files that define the agent itself, rendered for `model`. This is the
 * subset `eve init` writes when adding an agent to an existing project, where
 * everything outside `agent/` belongs to the host app.
 */
export function agentTemplateFiles(
  model: string,
  reasoning?: AgentReasoningDefinition,
): Record<string, string> {
  return {
    "agent/agent.ts": renderAgentTemplate(model, reasoning),
    "agent/channels/eve.ts": WEB_APP_TEMPLATE_FILES["agent/channels/eve.ts"],
    "agent/instructions.md": AGENT_INSTRUCTIONS_TEMPLATE,
  };
}

function renderAgentTemplate(
  model: string,
  reasoning: AgentReasoningDefinition | undefined,
): string {
  const chatGptModelId = parseChatGptModelSelection(model);
  if (chatGptModelId !== undefined) {
    return `import { defineAgent } from "eve";\nimport { chatgpt } from "eve/models/openai";\n\nexport default defineAgent({\n  model: chatgpt(${JSON.stringify(chatGptModelId)}),\n${reasoningTemplateLine(reasoning)}});\n`;
  }
  return BASE_AGENT_TEMPLATE.replaceAll("__EVE_INIT_MODEL__", model).replaceAll(
    "__EVE_INIT_REASONING__",
    reasoningTemplateLine(reasoning),
  );
}

function reasoningTemplateLine(reasoning: AgentReasoningDefinition | undefined): string {
  return reasoning === undefined || reasoning === "provider-default"
    ? ""
    : `  reasoning: "${reasoning}",\n`;
}

function renderTemplate(content: string, ctx: TemplateContext): string {
  if (content === BASE_AGENT_TEMPLATE && parseChatGptModelSelection(ctx.model) !== undefined) {
    return renderAgentTemplate(ctx.model, ctx.reasoning);
  }
  return content
    .replaceAll("__EVE_INIT_APP_NAME__", ctx.appName)
    .replaceAll("__EVE_INIT_MODEL__", ctx.model)
    .replaceAll("__EVE_INIT_REASONING__", reasoningTemplateLine(ctx.reasoning))
    .replaceAll("__EVE_INIT_BYOK_PROVIDER__", modelProviderSlug(ctx.model))
    .replaceAll("__EVE_INIT_BYOK_ENV_VAR__", byokProviderEnvVar(ctx.model))
    .replaceAll("__EVE_INIT_PACKAGE_VERSION__", formatEveDependencySpecifier(ctx.eveVersion))
    .replaceAll("__EVE_INIT_AI_SDK_VERSION__", ctx.aiPackageVersion)
    .replaceAll("__EVE_INIT_CONNECT_VERSION__", ctx.connectPackageVersion)
    .replaceAll("__EVE_INIT_ZOD_VERSION__", ctx.zodPackageVersion)
    .replaceAll("__EVE_INIT_TYPESCRIPT_VERSION__", ctx.typescriptPackageVersion)
    .replaceAll("__EVE_INIT_TYPES_NODE_VERSION__", ctx.nodeTypesVersion)
    .replaceAll("__EVE_INIT_NODE_ENGINE__", ctx.nodeEngine);
}

export function formatEveDependencySpecifier(versionOrSpecifier: string): string {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/.test(versionOrSpecifier)
    ? `^${versionOrSpecifier}`
    : versionOrSpecifier;
}

const BASE_AGENT_TEMPLATE = `import { defineAgent } from "eve";

export default defineAgent({
  model: "__EVE_INIT_MODEL__",
__EVE_INIT_REASONING__});
`;

// The agent reaches the model through a provider key the user supplies via the
// gateway `byok` block, not the managed Vercel AI Gateway. The provider and
// env var are derived from the chosen model's provider prefix; the key is
// quoted because provider slugs (e.g. hyphenated ones) need not be valid
// identifiers. The `process.env` access is typed by `@types/node`, which every
// scaffold ships (see `packageJsonTemplate`).
const BYOK_AGENT_TEMPLATE = `import { defineAgent } from "eve";

export default defineAgent({
  model: "__EVE_INIT_MODEL__",
__EVE_INIT_REASONING__  modelOptions: {
    providerOptions: {
      gateway: {
        byok: {
          "__EVE_INIT_BYOK_PROVIDER__": [{ apiKey: process.env.__EVE_INIT_BYOK_ENV_VAR__! }],
        },
      },
    },
  },
});
`;

function packageJsonTemplate(includeRootOnlyFields: boolean): string {
  const rootOnlyFields = includeRootOnlyFields ? ROOT_ONLY_PACKAGE_JSON_TEMPLATE_SUFFIX : "";
  return `{
  "name": "__EVE_INIT_APP_NAME__",
  "version": "0.0.0",
  "type": "module",
  "imports": {
    "#*": "./agent/*",
    "#evals/*": "./evals/*"
  },
  "scripts": {
    "build": "eve build",
    "deploy": "eve deploy",
    "dev": "eve dev",
    "eval": "eve eval",
    "start": "eve start",
    "typecheck": "tsc"
  },
  "dependencies": {
    "@vercel/connect": "__EVE_INIT_CONNECT_VERSION__",
    "ai": "__EVE_INIT_AI_SDK_VERSION__",
    "eve": "__EVE_INIT_PACKAGE_VERSION__",
    "zod": "__EVE_INIT_ZOD_VERSION__"
  },
  "devDependencies": {
    "@types/node": "__EVE_INIT_TYPES_NODE_VERSION__",
    "typescript": "__EVE_INIT_TYPESCRIPT_VERSION__"
  }${rootOnlyFields}
}
`;
}

/** Trailing fields only written when the scaffold is not a workspace member. */
export const ROOT_ONLY_PACKAGE_JSON_TEMPLATE_SUFFIX = `,
  "engines": {
    "node": "__EVE_INIT_NODE_ENGINE__"
  }
`;

const AGENT_INSTRUCTIONS_TEMPLATE = `# Identity

You are a helpful assistant.
`;

const SHARED_TEMPLATE_FILES: Record<string, string> = {
  "README.md": `# __EVE_INIT_APP_NAME__

This is an [eve](https://eve.dev) agent bootstrapped with [\`eve init\`](https://eve.dev/docs/reference/cli#eve-init).

## Getting started

First, run the development server:

\`\`\`bash
eve dev
\`\`\`

The development TUI opens an interactive session where you can send messages to your agent.

Start by editing \`agent/instructions.md\` to define the agent's identity, purpose, tone, and response guidelines. Configure its model and runtime behavior in \`agent/agent.ts\`.

Add capabilities under \`agent/\`, including tools, connections, channels, skills, subagents, and schedules. eve reloads your changes as you work.

## Learn more

To learn more about eve, explore these resources:

- [eve documentation](https://eve.dev/docs) — learn about eve's features and authoring APIs.
- [Build an Agent tutorial](https://eve.dev/docs/tutorial/first-agent) — build and deploy an agent step by step.
- [eve on GitHub](https://github.com/vercel/eve) — view the source and contribute.

## Deploy on Vercel

Deploy your agent to [Vercel](https://vercel.com) from the project root:

\`\`\`bash
eve deploy
\`\`\`

\`eve deploy\` links a Vercel project if needed and deploys the agent to production. See the [eve deployment documentation](https://eve.dev/docs/guides/deployment/vercel) for authentication, environment variables, and deployment options.
`,
  "agent/channels/eve.ts": WEB_APP_TEMPLATE_FILES["agent/channels/eve.ts"],
  "agent/instructions.md": AGENT_INSTRUCTIONS_TEMPLATE,
  "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    "types": ["node", "eve/workflow-modules"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["agent/**/*.ts", "evals/**/*.ts"]
}
`,
  ".gitignore": `node_modules
.env*
.eve
.vercel
.next
.output
.nitro
dist
.DS_Store
*.tsbuildinfo
`,
  // Vercel's CLI ignores .env.local and .env.*.local by default, but NOT a
  // bare .env — without the explicit pattern a source deploy uploads it.
  ".vercelignore": `node_modules
.env*
.eve
.next
.output
.nitro
dist
`,
  "AGENTS.md": `# eve Agent App

The agent is authored in \`agent/\`; eve compiles and runs it. Names come from paths, so \`agent/tools/weather.ts\`, \`agent/connections/crm.ts\`, and \`agent/channels/support.ts\` are named \`weather\`, \`crm\`, and \`support\`.

For a content-only change to the root agent's identity, purpose, tone, or response guidelines, edit its authored instructions (usually \`agent/instructions.md\`, sometimes \`agent/instructions.ts\` or \`agent/instructions/\`). Do not read framework docs or change \`agent/agent.ts\` unless the request changes agent-wide configuration.

## Route framework changes

Before authoring a framework capability, read its direct installed page for the file location, imports, and definition shape:

| Request | Read |
| --- | --- |
| Project layout | \`node_modules/eve/docs/getting-started.mdx\` |
| Agent configuration | \`node_modules/eve/docs/agent-config.md\` |
| Tool or approval policy | \`node_modules/eve/docs/tools/overview.mdx\` or \`tools/human-in-the-loop.md\` |
| MCP or OpenAPI service | \`node_modules/eve/docs/connections/mcp.mdx\` or \`connections/openapi.mdx\` |
| Built-in or custom channel | \`node_modules/eve/docs/channels/overview.mdx\` or \`channels/custom.mdx\` |
| Skill or schedule | \`node_modules/eve/docs/skills.mdx\` or \`schedules.mdx\` |
| Subagent, sandbox, auth, or client | \`node_modules/eve/docs/subagents/index.mdx\`, \`sandbox.mdx\`, \`guides/auth-and-route-protection.md\`, or \`guides/client/overview.mdx\` |
| Vercel or other deployment | \`node_modules/eve/docs/guides/deployment/vercel.mdx\` or \`guides/deployment/overview.md\` |

Read \`node_modules/eve/docs/README.md\` only when no row fits. Resolve the installed \`eve\` package first in a workspace or local install; if its docs are unavailable, use https://eve.dev/docs. Read the routed page before coding. Inspect only files you will change or imitate; do not enumerate the docs tree or recursively glob \`node_modules\` when the direct path is known.

For a named external product, search \`eve registry search <query> --json\`, inspect a candidate with \`eve registry view <item>\`, and install it with \`eve add <item> --non-interactive\`. For a generic capability, author a tool instead. Use \`eve link\` and \`eve deploy\` for Vercel operations. Implement the smallest complete behavior, then run the requested validation or the narrowest relevant check.
`,
  "CLAUDE.md": `@AGENTS.md
`,
};

function templateFiles(input: {
  byokProvider: boolean;
  includeRootOnlyPackageJsonFields: boolean;
}): Record<string, string> {
  return {
    "agent/agent.ts": input.byokProvider ? BYOK_AGENT_TEMPLATE : BASE_AGENT_TEMPLATE,
    ...SHARED_TEMPLATE_FILES,
    "package.json": packageJsonTemplate(input.includeRootOnlyPackageJsonFields),
  };
}

async function assertCanCreateInPlace(
  targetRoot: string,
  overwriteExisting: boolean,
): Promise<void> {
  if (!(await pathExists(targetRoot))) {
    return;
  }

  const entries = await readdir(targetRoot);
  const blocking = blockingCreateInPlaceEntries(entries);
  if (blocking.length > 0 && !overwriteExisting) {
    const visible = blocking.slice(0, 5).join(", ");
    const suffix = blocking.length > 5 ? `, and ${blocking.length - 5} more` : "";
    throw new Error(
      `Cannot create project in current directory because it is not empty. Found: ${visible}${suffix}. Use an empty directory.`,
    );
  }
}

export interface ScaffoldBaseProjectOptions {
  projectName: string;
  model: string;
  reasoning?: AgentReasoningDefinition;
  /**
   * The manager that owns command execution and manager-specific generated
   * project files for this scaffold.
   * Defaults to pnpm.
   */
  packageManager?: PackageManagerKind;
  targetDirectory?: string;
  overwriteExisting?: boolean;
  onOverwriteFile?: (filePath: string) => void | Promise<void>;
  evePackage?: EvePackageContract;
  aiPackageVersion?: string;
  connectPackageVersion?: string;
  zodPackageVersion?: string;
  typescriptPackageVersion?: string;
  /**
   * Final project path used to discover ancestor workspaces. This differs from
   * the write target only when the CLI stages a scaffold before moving it into
   * place.
   */
  workspaceProbeDirectory?: string;
  onWorkspaceRootMutation?: (mutation: WorkspaceRootMutation) => void | Promise<void>;
  /**
   * Scaffold an inline provider `byok` block in `agent.ts` that reads the
   * provider key from `process.env` instead of relying on the managed Vercel
   * AI Gateway. `process` is typed by the `@types/node` every scaffold ships.
   */
  byokProvider?: boolean;
}

export async function scaffoldBaseProject(options: ScaffoldBaseProjectOptions): Promise<string> {
  const targetRoot = resolve(options.targetDirectory ?? process.cwd(), options.projectName);
  const createInPlace = options.projectName === CURRENT_DIRECTORY_PROJECT_NAME;
  const overwriteExisting = options.overwriteExisting ?? false;
  const byokProvider = options.byokProvider ?? false;
  const packageManager = options.packageManager ?? "pnpm";
  const evePackage = resolveEvePackageContract(options.evePackage);
  const nodeEngine = pinnedNodeEngineMajor(evePackage.nodeEngine);
  const workspaceProbeRoot = resolve(options.workspaceProbeDirectory ?? targetRoot);
  const workspaceMember = isPackageManagerWorkspaceMember(packageManager, workspaceProbeRoot);

  if (createInPlace) {
    await assertCanCreateInPlace(targetRoot, overwriteExisting);
  } else if (await pathExists(targetRoot)) {
    throw new Error(`Cannot create project because "${targetRoot}" already exists.`);
  }

  const ctx: TemplateContext = {
    appName: basename(targetRoot),
    model: options.model,
    reasoning: options.reasoning,
    eveVersion: evePackage.version,
    aiPackageVersion: resolveVersionToken(
      "aiPackageVersion",
      options.aiPackageVersion ?? DEFAULT_AI_PACKAGE_VERSION,
    ),
    // Channels and connections scaffolded later (`eve add channel/slack`,
    // possibly while `eve dev` is running) import `@vercel/connect`; shipping
    // it from init means adding them never introduces a missing dependency.
    connectPackageVersion: resolveVersionToken(
      "connectPackageVersion",
      options.connectPackageVersion ?? DEFAULT_CONNECT_PACKAGE_VERSION,
    ),
    zodPackageVersion: resolveVersionToken(
      "zodPackageVersion",
      options.zodPackageVersion ?? DEFAULT_ZOD_PACKAGE_VERSION,
    ),
    typescriptPackageVersion: resolveVersionToken(
      "typescriptPackageVersion",
      options.typescriptPackageVersion ?? DEFAULT_TYPESCRIPT_PACKAGE_VERSION,
    ),
    nodeTypesVersion: nodeEngine,
    nodeEngine,
  };

  await mkdir(targetRoot, { recursive: true });

  for (const [relPath, content] of Object.entries(
    templateFiles({
      byokProvider,
      includeRootOnlyPackageJsonFields: !workspaceMember,
    }),
  )) {
    const filePath = `${targetRoot}/${relPath}`;
    const existed = await pathExists(filePath);
    await writeTextFile(filePath, renderTemplate(content, ctx), {
      force: createInPlace && overwriteExisting,
    });
    if (existed) {
      await options.onOverwriteFile?.(filePath);
    }
  }

  await applyPackageManagerWorkspaceConfiguration({
    packageManager,
    projectRoot: targetRoot,
    workspaceProbeRoot,
    onWorkspaceRootMutation: options.onWorkspaceRootMutation,
  });

  await patchWorkspaceRootPackageJson(packageManager, workspaceProbeRoot, {
    nodeEngineRequirement: evePackage.nodeEngine,
    onWorkspaceRootMutation: options.onWorkspaceRootMutation,
  });

  return targetRoot;
}

export async function isEveProject(projectRoot: string): Promise<boolean> {
  for (const extension of SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS) {
    try {
      await stat(join(projectRoot, "agent", `agent${extension}`));
      return true;
    } catch {
      // Continue trying the other authored module extensions.
    }
  }
  return false;
}
