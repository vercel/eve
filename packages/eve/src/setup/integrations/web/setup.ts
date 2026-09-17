import { join } from "node:path";

import { resolveEveProjectContext } from "#internal/project-context.js";
import { detectPackageManager } from "#setup/package-manager.js";
import { pathExists, writeTextFile } from "#setup/scaffold/files.js";
import { WEB_CHANNEL_TEMPLATE } from "#setup/scaffold/create/web-template.js";
import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";

export interface WebSetupDeps {
  detectPackageManager: typeof detectPackageManager;
  pathExists: typeof pathExists;
  resolveEveProjectContext: typeof resolveEveProjectContext;
  writeTextFile: typeof writeTextFile;
}

const defaultDeps: WebSetupDeps = {
  detectPackageManager,
  pathExists,
  resolveEveProjectContext,
  writeTextFile,
};

export interface WebSetupPlan {
  configureVercelServices: boolean;
  packageManager: Awaited<ReturnType<typeof detectPackageManager>>["kind"];
}

export async function prepareWebSetup(
  context: SetupPrepareContext,
  deps: WebSetupDeps = defaultDeps,
): Promise<WebSetupPlan> {
  return {
    packageManager: (await deps.detectPackageManager(context.appRoot)).kind,
    configureVercelServices: context.environment.vercel.kind === "available",
  };
}

export async function applyWebSetup(
  _plan: WebSetupPlan,
  context: SetupApplyContext,
  deps: WebSetupDeps = defaultDeps,
) {
  const channelPath = join(context.appRoot, "agent", "channels", "eve.ts");
  if (context.force || !(await deps.pathExists(channelPath))) {
    await deps.writeTextFile(channelPath, WEB_CHANNEL_TEMPLATE, { force: context.force });
  }
  const project = await deps.resolveEveProjectContext(context.appRoot);
  if (project.kind === "workspace") {
    throw new Error("Web Chat setup requires a selected workspace agent.");
  }
  const agentName = project.kind === "workspace-member" ? project.member.name : undefined;
  const webRoot = join(project.environmentRoot, "apps", "web");
  await deps.writeTextFile(
    join(webRoot, "app", "eve-agent.ts"),
    `/** Named workspace agent selected by the Web Chat installer. */\nexport const WEB_CHAT_AGENT: string | undefined = ${agentName === undefined ? "undefined" : JSON.stringify(agentName)};\n`,
    { force: true },
  );
  await deps.writeTextFile(
    join(webRoot, "next.config.ts"),
    'import type { NextConfig } from "next";\nimport { withEve } from "eve/next";\n\nconst nextConfig: NextConfig = {};\n\nexport default withEve(nextConfig, { eveRoot: "../.." });\n',
    { force: true },
  );
  context.presenter.log.success("Configured channel: web");
  return { facts: [], deploymentRequired: true as const };
}

export const WEB_SETUP = defineSetupIntegration({
  kind: "web",
  label: "Web Chat",
  hint: "Browser-based chat interface",
  prepare: prepareWebSetup,
  apply: applyWebSetup,
});
