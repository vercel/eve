import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveEveProjectContext } from "#internal/project-context.js";
import { detectPackageManager, type PackageManagerKind } from "#setup/package-manager.js";
import { pathExists, writeTextFile } from "#setup/scaffold/files.js";
import { WEB_CHANNEL_TEMPLATE } from "#setup/scaffold/create/web-template.js";
import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";

const LEGACY_NEXT_HOSTED_CONFIG = `import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {};

export default withEve(nextConfig, { eveRoot: "../.." });
`;
const PEER_SERVICE_NEXT_CONFIG = `import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
`;
const PEER_SERVICE_VERCEL_CONFIG = `import { withEve } from "eve/vercel";

export default await withEve({
  services: {
    web: { framework: "nextjs", root: "apps/web" },
  },
  routes: [
    { src: "^(.*)$", destination: { type: "service", service: "web" } },
  ],
});
`;

export interface WebSetupDeps {
  detectPackageManager: typeof detectPackageManager;
  pathExists: typeof pathExists;
  readTextFile(path: string): Promise<string>;
  resolveEveProjectContext: typeof resolveEveProjectContext;
  writeTextFile: typeof writeTextFile;
}

const defaultDeps: WebSetupDeps = {
  detectPackageManager,
  pathExists,
  readTextFile: (path) => readFile(path, "utf8"),
  resolveEveProjectContext,
  writeTextFile,
};

export interface WebSetupPlan {
  packageManager: PackageManagerKind;
}

export async function prepareWebSetup(
  context: SetupPrepareContext,
  deps: WebSetupDeps = defaultDeps,
): Promise<WebSetupPlan> {
  const project = await deps.resolveEveProjectContext(context.appRoot);
  if (project.kind === "workspace") {
    throw new Error("Web Chat setup requires a selected workspace agent.");
  }
  return { packageManager: (await deps.detectPackageManager(project.environmentRoot)).kind };
}

function devCommand(packageManager: PackageManagerKind): string {
  switch (packageManager) {
    case "npm":
      return "npm run dev";
    case "pnpm":
      return "pnpm dev";
    case "yarn":
      return "yarn dev";
    case "bun":
      return "bun run dev";
  }
}

async function configurePeerServiceScripts(root: string, deps: WebSetupDeps): Promise<void> {
  const path = join(root, "package.json");
  const document = JSON.parse(await deps.readTextFile(path)) as {
    scripts?: Record<string, string>;
    [key: string]: unknown;
  };
  const scripts = { ...document.scripts };
  scripts["dev:eve"] ??= "eve dev";
  scripts["dev:services"] ??= "vercel dev --local";
  if (scripts.dev === undefined || scripts.dev === "eve dev") {
    scripts.dev = "vercel dev --local";
  }
  await deps.writeTextFile(path, `${JSON.stringify({ ...document, scripts }, null, 2)}\n`, {
    force: true,
  });
}

async function assertInstallerOwned(path: string, allowed: readonly string[]): Promise<void> {
  try {
    const source = await readFile(path, "utf8");
    if (allowed.includes(source)) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    `Could not configure Web Chat because ${path} contains authored configuration. Preserve it and compose the eve integration manually.`,
  );
}

export async function applyWebSetup(
  plan: WebSetupPlan,
  context: SetupApplyContext,
  deps: WebSetupDeps = defaultDeps,
) {
  const project = await deps.resolveEveProjectContext(context.appRoot);
  if (project.kind === "workspace") {
    throw new Error("Web Chat setup requires a selected workspace agent.");
  }
  const agentAppRoot =
    project.kind === "workspace-member" ? project.member.appRoot : project.appRoot;
  const channelPath = join(agentAppRoot, "agent", "channels", "eve.ts");
  if (context.force || !(await deps.pathExists(channelPath))) {
    await deps.writeTextFile(channelPath, WEB_CHANNEL_TEMPLATE, { force: context.force });
  }
  const agentName = project.kind === "workspace-member" ? project.member.name : undefined;
  const webRoot = join(project.environmentRoot, "apps", "web");
  await deps.writeTextFile(
    join(webRoot, "app", "eve-agent.ts"),
    `/** Named workspace agent selected by the Web Chat installer. */\nexport const WEB_CHAT_AGENT: string | undefined = ${agentName === undefined ? "undefined" : JSON.stringify(agentName)};\n`,
    { force: true },
  );
  const nextConfigPath = join(webRoot, "next.config.ts");
  const registryNextConfig = `import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {};

export default withEve(nextConfig);
`;
  await assertInstallerOwned(nextConfigPath, [
    registryNextConfig,
    LEGACY_NEXT_HOSTED_CONFIG,
    PEER_SERVICE_NEXT_CONFIG,
  ]);
  const vercelTsPath = join(project.environmentRoot, "vercel.ts");
  const vercelJsonPath = join(project.environmentRoot, "vercel.json");
  await assertInstallerOwned(vercelTsPath, [PEER_SERVICE_VERCEL_CONFIG]);
  if (await deps.pathExists(vercelJsonPath)) {
    throw new Error(
      `Could not configure peer services because ${vercelJsonPath} already exists. Preserve it and compose eve/vercel manually.`,
    );
  }
  await deps.writeTextFile(nextConfigPath, PEER_SERVICE_NEXT_CONFIG, { force: true });
  await deps.writeTextFile(vercelTsPath, PEER_SERVICE_VERCEL_CONFIG, { force: true });
  await configurePeerServiceScripts(project.environmentRoot, deps);
  context.presenter.log.success("Configured channel: web");
  context.presenter.nextSteps([
    `Run \`${devCommand(plan.packageManager)}\` from the project root to start Web Chat and your agent services.`,
  ]);
  return { facts: [] };
}

export const WEB_SETUP = defineSetupIntegration({
  kind: "web",
  label: "Web Chat",
  hint: "Browser-based chat interface",
  prepare: prepareWebSetup,
  apply: applyWebSetup,
});
