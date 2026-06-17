import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { PackageManagerKind } from "../../package-manager.js";
import { pinnedNodeEngineMajor } from "../../node-engine.js";
import { getPackageManagerStrategy } from "../../primitives/pm/index.js";
import { SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS } from "../update/module-files.js";
import { pathExists, writeTextFile } from "../files.js";
import { resolveVersionToken } from "../version-tokens.js";
import { WEB_APP_TEMPLATE_FILES } from "./web-template.js";

export const CURRENT_DIRECTORY_PROJECT_NAME = ".";

const ALLOWED_CREATE_IN_PLACE_ENTRIES = new Set([".DS_Store", ".git", ".gitkeep", ".hg"]);

export const DEFAULT_AI_PACKAGE_VERSION = "__AI_SDK_VERSION__";
export const DEFAULT_CONNECT_PACKAGE_VERSION = "__VERCEL_CONNECT_VERSION__";
export const DEFAULT_ZOD_PACKAGE_VERSION = "__ZOD_VERSION__";
const DEFAULT_TSGO_PACKAGE_VERSION = "__TSGO_VERSION__";

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
  version: "__EVE_PACKAGE_VERSION__",
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
  eveVersion: string;
  aiPackageVersion: string;
  connectPackageVersion: string;
  zodPackageVersion: string;
  tsgoPackageVersion: string;
  nodeTypesVersion: string;
  nodeEngine: string;
}

/**
 * Provider slug a gateway model id routes through: the segment before the
 * first "/" (e.g. `anthropic/claude-sonnet-4.6` → `anthropic`). The slug is
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
export function agentTemplateFiles(model: string): Record<string, string> {
  return {
    "agent/agent.ts": BASE_AGENT_TEMPLATE.replaceAll("__EVE_INIT_MODEL__", model),
    "agent/channels/eve.ts": WEB_APP_TEMPLATE_FILES["agent/channels/eve.ts"],
    "agent/instructions.md": AGENT_INSTRUCTIONS_TEMPLATE,
  };
}

function renderTemplate(content: string, ctx: TemplateContext): string {
  return content
    .replaceAll("__EVE_INIT_APP_NAME__", ctx.appName)
    .replaceAll("__EVE_INIT_MODEL__", ctx.model)
    .replaceAll("__EVE_INIT_BYOK_PROVIDER__", modelProviderSlug(ctx.model))
    .replaceAll("__EVE_INIT_BYOK_ENV_VAR__", byokProviderEnvVar(ctx.model))
    .replaceAll("__EVE_INIT_PACKAGE_VERSION__", formatEveDependencySpecifier(ctx.eveVersion))
    .replaceAll("__EVE_INIT_AI_SDK_VERSION__", ctx.aiPackageVersion)
    .replaceAll("__EVE_INIT_CONNECT_VERSION__", ctx.connectPackageVersion)
    .replaceAll("__EVE_INIT_ZOD_VERSION__", ctx.zodPackageVersion)
    .replaceAll("__EVE_INIT_TSGO_VERSION__", ctx.tsgoPackageVersion)
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
});
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
  modelOptions: {
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

// `@vercel/connect`'s optional `ai` peer (`^6 || ^7`) excludes prereleases, so
// npm and yarn refuse to fill it from the prerelease `ai` the eve runtime pins
// and abort the install (ERESOLVE). Forcing `ai` through `overrides` (npm/bun)
// and `resolutions` (yarn) keeps the whole tree on that exact version; pnpm
// already tolerates the unmet optional peer and ignores both fields.
function packageJsonTemplate(): string {
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
    "dev": "eve dev",
    "start": "eve start",
    "typecheck": "tsgo"
  },
  "dependencies": {
    "@vercel/connect": "__EVE_INIT_CONNECT_VERSION__",
    "ai": "__EVE_INIT_AI_SDK_VERSION__",
    "eve": "__EVE_INIT_PACKAGE_VERSION__",
    "zod": "__EVE_INIT_ZOD_VERSION__"
  },
  "devDependencies": {
    "@types/node": "__EVE_INIT_TYPES_NODE_VERSION__",
    "@typescript/native-preview": "__EVE_INIT_TSGO_VERSION__"
  },
  "overrides": {
    "ai": "__EVE_INIT_AI_SDK_VERSION__"
  },
  "resolutions": {
    "ai": "__EVE_INIT_AI_SDK_VERSION__"
  },
  "engines": {
    "node": "__EVE_INIT_NODE_ENGINE__"
  }
}
`;
}

const AGENT_INSTRUCTIONS_TEMPLATE = `# Identity

You are a helpful assistant.
`;

const SHARED_TEMPLATE_FILES: Record<string, string> = {
  "agent/channels/eve.ts": WEB_APP_TEMPLATE_FILES["agent/channels/eve.ts"],
  "agent/instructions.md": AGENT_INSTRUCTIONS_TEMPLATE,
  "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["agent/**/*.ts", "evals/**/*.ts", ".eve/**/*.d.ts"]
}
`,
  ".gitignore": `node_modules
.env*
.eve
.vercel
.workflow-data
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
.workflow-data
.next
.output
.nitro
dist
`,
  "AGENTS.md": `# eve Agent App

This project uses the eve framework. Before writing code, always read the relevant guide in \`node_modules/eve/docs/\`.
`,
  "CLAUDE.md": `@AGENTS.md
`,
};

function templateFiles(
  byokProvider: boolean,
  packageManager: PackageManagerKind,
): Record<string, string> {
  return {
    "agent/agent.ts": byokProvider ? BYOK_AGENT_TEMPLATE : BASE_AGENT_TEMPLATE,
    ...SHARED_TEMPLATE_FILES,
    "package.json": packageJsonTemplate(),
    ...getPackageManagerStrategy(packageManager).scaffoldFiles,
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
  const blocking = entries.filter((entry) => !ALLOWED_CREATE_IN_PLACE_ENTRIES.has(entry));
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
  tsgoPackageVersion?: string;
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

  if (createInPlace) {
    await assertCanCreateInPlace(targetRoot, overwriteExisting);
  } else if (await pathExists(targetRoot)) {
    throw new Error(`Cannot create project because "${targetRoot}" already exists.`);
  }

  const ctx: TemplateContext = {
    appName: basename(targetRoot),
    model: options.model,
    eveVersion: evePackage.version,
    aiPackageVersion: resolveVersionToken(
      "aiPackageVersion",
      options.aiPackageVersion ?? DEFAULT_AI_PACKAGE_VERSION,
    ),
    // Channels and connections scaffolded later (`eve channels add slack`,
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
    tsgoPackageVersion: resolveVersionToken(
      "tsgoPackageVersion",
      options.tsgoPackageVersion ?? DEFAULT_TSGO_PACKAGE_VERSION,
    ),
    nodeTypesVersion: nodeEngine,
    nodeEngine,
  };

  await mkdir(targetRoot, { recursive: true });

  for (const [relPath, content] of Object.entries(templateFiles(byokProvider, packageManager))) {
    const filePath = `${targetRoot}/${relPath}`;
    const existed = await pathExists(filePath);
    await writeTextFile(filePath, renderTemplate(content, ctx), {
      force: createInPlace && overwriteExisting,
    });
    if (existed) {
      await options.onOverwriteFile?.(filePath);
    }
  }

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
