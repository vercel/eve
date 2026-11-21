import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { PackageManagerKind } from "../../package-manager.js";
import { pinnedNodeEngineMajor } from "../../node-engine.js";
import type { AgentReasoningDefinition } from "../../../shared/agent-definition.js";
import { parseChatGptModelSelection } from "../../../shared/chatgpt-model.js";
import { SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS } from "../update/module-files.js";
import { pathExists, writeTextFile } from "../files.js";
import { blockingCreateInPlaceEntries } from "../create-in-place.js";
import { DEFAULT_CONNECT_PACKAGE_VERSION, resolveVersionToken } from "../version-tokens.js";
import {
  applyPackageManagerWorkspaceConfiguration,
  isPackageManagerWorkspaceMember,
  patchWorkspaceRootPackageJson,
  type WorkspaceRootMutation,
} from "../workspace-root.js";
import { WEB_CHANNEL_TEMPLATES } from "./web-template.js";
import { AGENT_INSTRUCTIONS_TEMPLATE } from "./instructions-template.js";
import { SCAFFOLDED_AGENT_PATHS } from "./agent-paths.js";

export const CURRENT_DIRECTORY_PROJECT_NAME = ".";

export const DEFAULT_AI_PACKAGE_VERSION = "__AI_SDK_VERSION__";
export { DEFAULT_CONNECT_PACKAGE_VERSION } from "../version-tokens.js";
export const DEFAULT_ZOD_PACKAGE_VERSION = "__ZOD_VERSION__";
const DEFAULT_TYPESCRIPT_PACKAGE_VERSION = "__TYPESCRIPT_VERSION__";

export interface EvePackageContract {
  version: string;
  nodeEngine: string;
}

export const DEFAULT_EVE_PACKAGE_CONTRACT: EvePackageContract = {
  version: "__EVE_PACKAGE_DEPENDENCY_VERSION__",
  nodeEngine: "__NODE_ENGINE__",
};

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

export function modelProviderSlug(modelId: string): string {
  const provider = (modelId.split("/")[0] ?? "").replaceAll(/[^A-Za-z0-9._-]/gu, "");
  return provider.length > 0 ? provider : "anthropic";
}

export function byokProviderEnvVar(modelId: string): string {
  const name = modelProviderSlug(modelId)
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/gu, "_");
  return `${/^[0-9]/.test(name) ? "_" : ""}${name}_API_KEY`;
}

export function agentTemplateFiles(
  model: string,
  reasoning?: AgentReasoningDefinition,
): Record<string, string> {
  return {
    [SCAFFOLDED_AGENT_PATHS.config]: renderAgentTemplate(model, reasoning),
    [SCAFFOLDED_AGENT_PATHS.channel]: WEB_CHANNEL_TEMPLATES.default,
    [SCAFFOLDED_AGENT_PATHS.instructions]: AGENT_INSTRUCTIONS_TEMPLATE,
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

export const ROOT_ONLY_PACKAGE_JSON_TEMPLATE_SUFFIX = `,
  "engines": {
    "node": "__EVE_INIT_NODE_ENGINE__"
  }
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
- [eve on GitHub](https://github.com/vercel/eve) — view the source and contribute.

## Deploy on Vercel

Deploy your agent to [Vercel](https://vercel.com) from the project root:

\`\`\`bash
eve deploy
\`\`\`

\`eve deploy\` links a Vercel project if needed and deploys the agent to production. See the [eve deployment documentation](https://eve.dev/docs/guides/deployment/vercel) for authentication, environment variables, and deployment options.
`,
  [SCAFFOLDED_AGENT_PATHS.channel]: WEB_CHANNEL_TEMPLATES.default,
  [SCAFFOLDED_AGENT_PATHS.instructions]: AGENT_INSTRUCTIONS_TEMPLATE,
  "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    "types": ["node"],
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
  ".vercelignore": `node_modules
.env*
.eve
.next
.output
.nitro
dist
`,
  "AGENTS.md": `# eve Agent App

This project uses the eve framework: an agent is a directory of files under \`agent/\`, and eve compiles and runs it.

For a content-only change to the root agent's identity, purpose, tone, or response guidelines, edit its existing authored instructions. Fresh projects use \`agent/instructions.md\`; a project may instead use \`agent/instructions.ts\` or files under \`agent/instructions/\`. You do not need to read the framework docs for a content-only instructions change. A fresh project already has its selected model in \`agent/agent.ts\`; preserve that file unless the user asks to change the model.

## Read the docs before writing code

\`\`\`sh
ls node_modules/eve/docs
\`\`\`

Start with \`docs/README.md\`: it maps each task to the page that covers it. Read that page before authoring tools, connections, channels, skills, subagents, schedules, or deployment. In a workspace or local package install, resolve the installed \`eve\` package location first. If the package docs are missing, use https://eve.dev/docs.

Use a bounded authoring loop:

1. Read the relevant page and inspect only files you will modify or need to imitate.
2. Stop discovery once the file location, imports, and definition shape are clear. Implement the smallest complete behavior the user requested.
3. Run one narrow verification. Start with \`eve info\`: it loads every agent file without starting a server, lists each problem with its file, and exits 1 when the agent won't compile. Expand investigation only when it fails or the request needs project-specific details.

Follow links or inspect public types only when the routed page leaves the task unanswered. Do not recursively glob \`node_modules\`, enumerate the entire docs tree, or read unrelated scaffold files when the direct path is known. Package-manager links can hide files from recursive glob tools even though direct reads work.

Keep the bundle small: import SDK clients inside the functions that use them, and keep one version of each dependency. See \`docs/guides/deployment/index.md#keep-the-bundle-small\`.

## Prefer an existing integration

When a task names an external product or service, search the registry before implementing its integration. For a generic capability, author a tool instead.

\`\`\`sh
eve registry search <query> --json
eve registry view <item>
\`\`\`

Prefer items whose \`implementation\` is \`native\`; use Chat SDK adapters when no native channel fits. \`registry view\` links the item's documentation.

Install without driving interactive prompts:

\`\`\`sh
eve add <item> --non-interactive
\`\`\`

Exit code 0 means setup completed, 1 failed, and 2 needs an answer or a prerequisite. On exit 2, run the \`next.command\` from the final NDJSON event. For a non-secret question, replace its \`<JSON value>\` answer placeholder with the answer you collected; string values need JSON quotes. Never pass a secret in \`--answer\`. See \`docs/install-integrations.mdx\` for setup prerequisites.

## Use eve for Vercel operations

Use eve to link and deploy Vercel projects:

\`\`\`sh
eve link --non-interactive --project <name-or-id> [--team <team-id-or-slug>]
eve deploy --non-interactive --yes [--project <name-or-id>]
\`\`\`

A setup may report \`eve link\` as a prerequisite; run it, then retry the continuation. When a completed setup event has \`deploymentRequired: true\`, run the \`next\` command it reports.

## Validate the change

Run the validation the task requests. When it does not establish the behavior you changed, run the narrowest relevant check.
`,
  "CLAUDE.md": `@AGENTS.md
`,
};

function templateFiles(input: {
  byokProvider: boolean;
  includeRootOnlyPackageJsonFields: boolean;
}): Record<string, string> {
  return {
    [SCAFFOLDED_AGENT_PATHS.config]: input.byokProvider ? BYOK_AGENT_TEMPLATE : BASE_AGENT_TEMPLATE,
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
  packageManager?: PackageManagerKind;
  targetDirectory?: string;
  overwriteExisting?: boolean;
  onOverwriteFile?: (filePath: string) => void | Promise<void>;
  evePackage?: EvePackageContract;
  aiPackageVersion?: string;
  connectPackageVersion?: string;
  zodPackageVersion?: string;
  typescriptPackageVersion?: string;
  workspaceProbeDirectory?: string;
  onWorkspaceRootMutation?: (mutation: WorkspaceRootMutation) => void | Promise<void>;
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
    } catch {}
  }
  return false;
}
