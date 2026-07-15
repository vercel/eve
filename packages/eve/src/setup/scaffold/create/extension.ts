import { mkdir, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

import type { PackageManagerKind } from "../../package-manager.js";
import { pinnedNodeEngineMajor } from "../../node-engine.js";
import { pathExists, writeTextFile } from "../files.js";
import { resolveVersionToken } from "../version-tokens.js";
import {
  applyPackageManagerWorkspaceConfiguration,
  isPackageManagerWorkspaceMember,
  patchWorkspaceRootPackageJson,
  type WorkspaceRootMutation,
} from "../workspace-root.js";
import {
  CURRENT_DIRECTORY_PROJECT_NAME,
  DEFAULT_EVE_PACKAGE_CONTRACT,
  DEFAULT_ZOD_PACKAGE_VERSION,
  formatEveDependencySpecifier,
  resolveEvePackageContract,
  ROOT_ONLY_PACKAGE_JSON_TEMPLATE_SUFFIX,
  type EvePackageContract,
} from "./project.js";

const ALLOWED_CREATE_IN_PLACE_ENTRIES = new Set([".DS_Store", ".git", ".gitkeep", ".hg"]);
const DEFAULT_TYPESCRIPT_PACKAGE_VERSION = "__TYPESCRIPT_VERSION__";

interface ExtensionTemplateContext {
  appName: string;
  eveVersion: string;
  zodPackageVersion: string;
  typescriptPackageVersion: string;
  nodeTypesVersion: string;
  nodeEngine: string;
}

function renderTemplate(content: string, ctx: ExtensionTemplateContext): string {
  return content
    .replaceAll("__EVE_INIT_APP_NAME__", ctx.appName)
    .replaceAll("__EVE_INIT_PACKAGE_VERSION__", formatEveDependencySpecifier(ctx.eveVersion))
    .replaceAll("__EVE_INIT_ZOD_VERSION__", ctx.zodPackageVersion)
    .replaceAll("__EVE_INIT_TYPESCRIPT_VERSION__", ctx.typescriptPackageVersion)
    .replaceAll("__EVE_INIT_TYPES_NODE_VERSION__", ctx.nodeTypesVersion)
    .replaceAll("__EVE_INIT_NODE_ENGINE__", ctx.nodeEngine);
}

/**
 * Extension package.json as a plain object so named fields like `exports` stay
 * structured. Tokens are still substituted by {@link renderTemplate}.
 */
function packageJsonTemplate(includeRootOnlyFields: boolean): string {
  const packageJson = {
    name: "__EVE_INIT_APP_NAME__",
    version: "0.0.0",
    type: "module",
    eve: {
      extension: "./extension",
    },
    files: ["extension", "dist"],
    exports: {
      ".": "./extension/extension.ts",
    },
    scripts: {
      build: "eve extension build",
      prepare: "eve extension build",
      typecheck: "tsc",
    },
    dependencies: {
      zod: "__EVE_INIT_ZOD_VERSION__",
    },
    devDependencies: {
      "@types/node": "__EVE_INIT_TYPES_NODE_VERSION__",
      eve: "__EVE_INIT_PACKAGE_VERSION__",
      typescript: "__EVE_INIT_TYPESCRIPT_VERSION__",
    },
    peerDependencies: {
      eve: "__EVE_INIT_PACKAGE_VERSION__",
    },
  };

  // Same trailing engines block the agent scaffold appends for non-workspace roots.
  return `${JSON.stringify(packageJson, null, 2).slice(0, -1)}${
    includeRootOnlyFields ? ROOT_ONLY_PACKAGE_JSON_TEMPLATE_SUFFIX : ""
  }}\n`;
}

const EXTENSION_DECLARATION_TEMPLATE = `import { defineExtension } from "eve/extension";
import { z } from "zod";

export default defineExtension({
  config: z.object({
    // Replace with the settings consumers pass at the mount site.
    apiKey: z.string(),
  }),
});
`;

const TSCONFIG_TEMPLATE = `{
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
  "include": ["extension/**/*.ts"]
}
`;

const GITIGNORE_TEMPLATE = `node_modules
.env*
.eve
.vercel
.output
.nitro
dist
.DS_Store
*.tsbuildinfo
`;

const AGENTS_MD_TEMPLATE = `# eve Extension Package

This package is an eve extension — a reusable package of tools, connections,
skills, hooks, and instruction fragments that a consuming agent mounts under
\`agent/extensions/\`.

Before writing code, read the Extensions guide from the installed eve package
docs. In most installs, those docs are at \`node_modules/eve/docs/extensions.md\`.
In workspaces or local package installs, resolve the installed \`eve\` package
location first and read its \`docs/extensions.md\`. If package docs are
unavailable, use https://eve.dev/docs/extensions as a fallback.

## Authoring

- Declare the extension in \`extension/extension.ts\` with \`defineExtension\` from
  \`eve/extension\`. Config is optional; read bound values via the handle's
  \`.config\` in tools and hooks.
- Add contributions under \`extension/\` the same way as in an agent:
  \`tools/\`, \`connections/\`, \`skills/\`, \`hooks/\`, and optional instruction
  fragments. Names come from file paths; the mount supplies the namespace, so
  name tools for what they do (\`search\`, not \`crm_search\`).
- An extension cannot declare \`agent.ts\`, \`sandbox\`, \`schedules\`, or nested
  \`extensions/\` — those belong to the consuming agent.

## Build and publish

\`eve extension build\` (wired to \`build\`/\`prepare\`) compiles the mount factory
and tool re-exports into \`dist/\` and fills the package \`exports\` map. Ship both
\`extension/\` (source the consumer recompiles) and \`dist/\`. Keep \`eve\` as a peer
dependency so the consumer's eve is the one that runs.
`;

const CLAUDE_MD_TEMPLATE = `@AGENTS.md
`;

function templateFiles(includeRootOnlyPackageJsonFields: boolean): Record<string, string> {
  return {
    "extension/extension.ts": EXTENSION_DECLARATION_TEMPLATE,
    "tsconfig.json": TSCONFIG_TEMPLATE,
    ".gitignore": GITIGNORE_TEMPLATE,
    "AGENTS.md": AGENTS_MD_TEMPLATE,
    "CLAUDE.md": CLAUDE_MD_TEMPLATE,
    "package.json": packageJsonTemplate(includeRootOnlyPackageJsonFields),
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

export interface ScaffoldExtensionProjectOptions {
  projectName: string;
  /**
   * The manager that owns command execution and manager-specific generated
   * project files for this scaffold. Defaults to pnpm.
   */
  packageManager?: PackageManagerKind;
  targetDirectory?: string;
  overwriteExisting?: boolean;
  onOverwriteFile?: (filePath: string) => void | Promise<void>;
  evePackage?: EvePackageContract;
  zodPackageVersion?: string;
  typescriptPackageVersion?: string;
  /**
   * Final project path used to discover ancestor workspaces. This differs from
   * the write target only when the CLI stages a scaffold before moving it into
   * place.
   */
  workspaceProbeDirectory?: string;
  onWorkspaceRootMutation?: (mutation: WorkspaceRootMutation) => void | Promise<void>;
}

/**
 * Scaffolds a standalone eve extension package: `extension/extension.ts`, package
 * metadata (`eve.extension`, peer+dev `eve`, zod), and TypeScript config. Does
 * not write sample tools — authors add contributions under `extension/` themselves.
 */
export async function scaffoldExtensionProject(
  options: ScaffoldExtensionProjectOptions,
): Promise<string> {
  const targetRoot = resolve(options.targetDirectory ?? process.cwd(), options.projectName);
  const createInPlace = options.projectName === CURRENT_DIRECTORY_PROJECT_NAME;
  const overwriteExisting = options.overwriteExisting ?? false;
  const packageManager = options.packageManager ?? "pnpm";
  const evePackage = resolveEvePackageContract(options.evePackage ?? DEFAULT_EVE_PACKAGE_CONTRACT);
  const nodeEngine = pinnedNodeEngineMajor(evePackage.nodeEngine);
  const workspaceProbeRoot = resolve(options.workspaceProbeDirectory ?? targetRoot);
  const workspaceMember = isPackageManagerWorkspaceMember(packageManager, workspaceProbeRoot);

  if (createInPlace) {
    await assertCanCreateInPlace(targetRoot, overwriteExisting);
  } else if (await pathExists(targetRoot)) {
    throw new Error(`Cannot create project because "${targetRoot}" already exists.`);
  }

  const ctx: ExtensionTemplateContext = {
    appName: basename(targetRoot),
    eveVersion: evePackage.version,
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

  for (const [relPath, content] of Object.entries(templateFiles(!workspaceMember))) {
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

  // Extensions do not depend on `ai`; only reconcile engines.node on a workspace
  // root when the package is a member.
  await patchWorkspaceRootPackageJson(packageManager, workspaceProbeRoot, {
    nodeEngineRequirement: evePackage.nodeEngine,
    onWorkspaceRootMutation: options.onWorkspaceRootMutation,
  });

  return targetRoot;
}
