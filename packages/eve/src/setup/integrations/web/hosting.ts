import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { resolveEveProjectContext } from "#internal/project-context.js";
import { detectPackageManager, type PackageManagerKind } from "#setup/package-manager.js";
import { WEB_CHANNEL_TEMPLATES } from "#setup/scaffold/create/web-template.js";
import { pathExists, writeTextFile } from "#setup/scaffold/files.js";

export interface WebChatHostingDeps {
  detectPackageManager: typeof detectPackageManager;
  pathExists: typeof pathExists;
  readTextFile(path: string): Promise<string>;
  /** Defaults to a forced `rm`. */
  removeFile?(path: string): Promise<void>;
  resolveEveProjectContext: typeof resolveEveProjectContext;
  writeTextFile: typeof writeTextFile;
}

const removeFile = (path: string) => rm(path, { force: true });

export const defaultWebChatHostingDeps: WebChatHostingDeps = {
  detectPackageManager,
  pathExists,
  readTextFile: (path) => readFile(path, "utf8"),
  removeFile,
  resolveEveProjectContext,
  writeTextFile,
};

const PEER_SERVICE_SCRIPTS = {
  dev: "eve dev",
  "dev:eve": "eve dev",
  "dev:all": "vercel dev --local",
} as const;

export function peerServiceVercelConfig(
  framework: "nextjs" | "tanstack-start",
  buildCommand: string,
): string {
  return `import { withEve } from "eve/vercel";

export default await withEve({
  services: {
    web: {
      framework: "${framework}",
      root: "apps/web",
      buildCommand: "${buildCommand}",
    },
  },
  routes: [
    { src: "^(.*)$", destination: { type: "service", service: "web" } },
  ],
});
`;
}

export function runScriptCommand(packageManager: PackageManagerKind, script: string): string {
  switch (packageManager) {
    case "npm":
      return `npm run ${script}`;
    case "pnpm":
      return `pnpm ${script}`;
    case "yarn":
      return `yarn ${script}`;
    case "bun":
      return `bun run ${script}`;
  }
}

export interface WebChatProject {
  environmentRoot: string;
  agentAppRoot: string;
  /** Set for a workspace member so the chat app targets it by name. */
  agentName?: string;
}

export async function resolveWebChatProject(
  appRoot: string,
  deps: WebChatHostingDeps,
): Promise<WebChatProject> {
  const project = await deps.resolveEveProjectContext(appRoot);
  switch (project.kind) {
    case "workspace":
      throw new Error("Web Chat setup requires a selected workspace agent.");
    case "workspace-member":
      return {
        environmentRoot: project.environmentRoot,
        agentAppRoot: project.member.appRoot,
        agentName: project.member.name,
      };
    case "standalone":
      return { environmentRoot: project.environmentRoot, agentAppRoot: project.appRoot };
  }
}

type FileOwnership = "absent" | "installer" | "authored";

/** Whether `path` is absent, holds one of the `allowed` sources the installer writes, or is authored. */
async function readFileOwnership(
  path: string,
  allowed: readonly string[],
  deps: WebChatHostingDeps,
): Promise<FileOwnership> {
  if (!(await deps.pathExists(path))) return "absent";
  try {
    return allowed.includes(await deps.readTextFile(path)) ? "installer" : "authored";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

function assertNotAuthored(path: string, ownership: FileOwnership): void {
  if (ownership === "authored") {
    throw new Error(
      `Could not configure Web Chat because ${path} contains authored configuration. Preserve it and compose the eve integration manually.`,
    );
  }
}

async function updatePeerServiceScripts(
  root: string,
  deps: WebChatHostingDeps,
  update: (scripts: Record<string, string>) => void,
): Promise<void> {
  const path = join(root, "package.json");
  const document = JSON.parse(await deps.readTextFile(path)) as {
    scripts?: Record<string, string>;
    [key: string]: unknown;
  };
  const scripts = { ...document.scripts };
  update(scripts);
  if (JSON.stringify(scripts) === JSON.stringify({ ...document.scripts })) return;
  await deps.writeTextFile(path, `${JSON.stringify({ ...document, scripts }, null, 2)}\n`, {
    force: true,
  });
}

export interface WebChatHostingInput {
  project: WebChatProject;
  webRoot: string;
  force?: boolean;
  /** Whether to write the default channel when it is absent (or forced). */
  writeChannel: boolean;
  /** The web app's framework config, e.g. `next.config.ts`. */
  hostConfig: { path: string; source: string; owned: readonly string[] };
  vercelServices: boolean;
  /** The installer's `vercel.ts`, followed by any it wrote in earlier releases. */
  vercelConfigs: readonly [string, ...string[]];
}

/**
 * Checks every file Web Chat hosting would overwrite or remove, then returns
 * the writer, so an authored file fails setup before anything is written.
 */
export async function prepareWebChatHosting(
  input: WebChatHostingInput,
  deps: WebChatHostingDeps,
): Promise<() => Promise<void>> {
  const { project, webRoot, hostConfig } = input;
  const vercelTsPath = join(project.environmentRoot, "vercel.ts");
  const vercelJsonPath = join(project.environmentRoot, "vercel.json");
  assertNotAuthored(
    hostConfig.path,
    await readFileOwnership(hostConfig.path, hostConfig.owned, deps),
  );
  // Framework hosting leaves an authored vercel.ts (e.g. crons) alone and only
  // removes one the installer wrote for Vercel services.
  const vercelTsOwnership = await readFileOwnership(vercelTsPath, input.vercelConfigs, deps);
  if (input.vercelServices) {
    assertNotAuthored(vercelTsPath, vercelTsOwnership);
  }
  if (input.vercelServices && (await deps.pathExists(vercelJsonPath))) {
    throw new Error(
      `Could not configure Vercel services because ${vercelJsonPath} already exists. Preserve it and compose eve/vercel manually.`,
    );
  }
  return async () => {
    const channelPath = join(project.agentAppRoot, "agent", "channels", "eve.ts");
    if (input.writeChannel && (input.force || !(await deps.pathExists(channelPath)))) {
      await deps.writeTextFile(channelPath, WEB_CHANNEL_TEMPLATES.default, { force: input.force });
    }
    await deps.writeTextFile(
      join(webRoot, "app", "eve-agent.ts"),
      `/** Named workspace agent selected by the Web Chat installer. */\nexport const WEB_CHAT_AGENT: string | undefined = ${project.agentName === undefined ? "undefined" : JSON.stringify(project.agentName)};\n`,
      { force: true },
    );
    await deps.writeTextFile(hostConfig.path, hostConfig.source, { force: true });
    if (input.vercelServices) {
      await deps.writeTextFile(vercelTsPath, input.vercelConfigs[0], { force: true });
      await updatePeerServiceScripts(project.environmentRoot, deps, (scripts) => {
        for (const [name, command] of Object.entries(PEER_SERVICE_SCRIPTS)) {
          scripts[name] ??= command;
        }
      });
    } else if (vercelTsOwnership === "installer") {
      // A leftover services config keeps the root preset at "services", so Vercel
      // would route eve through both the services config and the framework host.
      await (deps.removeFile ?? removeFile)(vercelTsPath);
      await updatePeerServiceScripts(project.environmentRoot, deps, (scripts) => {
        for (const name of ["dev:eve", "dev:all"] as const) {
          if (scripts[name] === PEER_SERVICE_SCRIPTS[name]) delete scripts[name];
        }
      });
    }
  };
}
