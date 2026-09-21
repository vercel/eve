import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveEveProjectContext } from "#internal/project-context.js";
import { select } from "#setup/ask.js";
import { detectPackageManager, type PackageManagerKind } from "#setup/package-manager.js";
import { pathExists, writeTextFile } from "#setup/scaffold/files.js";
import { createPromptCommandOutput } from "#setup/cli/index.js";
import { syncHostFrameworkPreset } from "#setup/vercel-project-framework.js";
import { WEB_CHANNEL_TEMPLATE } from "#setup/scaffold/create/web-template.js";
import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";

const NEXT_HOSTED_CONFIG = `import type { NextConfig } from "next";
import { withEve } from "eve/next";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {};
const eveRoot = fileURLToPath(new URL("../..", import.meta.url));

export default withEve(nextConfig, { eveRoot });
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
  syncHostFrameworkPreset: typeof syncHostFrameworkPreset;
  writeTextFile: typeof writeTextFile;
}

const defaultDeps: WebSetupDeps = {
  detectPackageManager,
  pathExists,
  readTextFile: (path) => readFile(path, "utf8"),
  resolveEveProjectContext,
  syncHostFrameworkPreset,
  writeTextFile,
};

export interface WebSetupPlan {
  hosting: "next" | "vercel";
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
  const hosting = await context.asker.ask(
    select({
      key: "web-hosting",
      message: "How should Web Chat and agents be served?",
      options: [
        {
          id: "vercel",
          label: "Peer services (Recommended for Vercel)",
          hint: "Separate services in one Vercel project.",
          value: "vercel" as const,
        },
        {
          id: "next",
          label: "Next.js in front",
          hint: "One Next.js app serves Web Chat and all agent routes.",
          value: "next" as const,
        },
      ],
      recommended: "vercel" as const,
      required: true,
      hintLayout: "stacked",
    }),
  );
  if (hosting === "vercel") {
    await context.resolveVercelProject("Web Chat");
  }
  return {
    hosting,
    packageManager: (await deps.detectPackageManager(project.environmentRoot)).kind,
  };
}

function runScriptCommand(packageManager: PackageManagerKind, script: string): string {
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

async function configurePeerServiceScripts(root: string, deps: WebSetupDeps): Promise<void> {
  const path = join(root, "package.json");
  const document = JSON.parse(await deps.readTextFile(path)) as {
    scripts?: Record<string, string>;
    [key: string]: unknown;
  };
  const scripts = { ...document.scripts };
  scripts.dev ??= "eve dev";
  scripts["dev:eve"] ??= "eve dev";
  scripts["dev:services"] ??= "vercel dev";
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
    NEXT_HOSTED_CONFIG,
    PEER_SERVICE_NEXT_CONFIG,
  ]);
  let startScript: string;
  if (plan.hosting === "vercel") {
    const vercelTsPath = join(project.environmentRoot, "vercel.ts");
    const vercelJsonPath = join(project.environmentRoot, "vercel.json");
    await assertInstallerOwned(vercelTsPath, [PEER_SERVICE_VERCEL_CONFIG]);
    if (await deps.pathExists(vercelJsonPath)) {
      throw new Error(
        `Could not configure Vercel services because ${vercelJsonPath} already exists. Preserve it and compose eve/vercel manually.`,
      );
    }
    await deps.writeTextFile(nextConfigPath, PEER_SERVICE_NEXT_CONFIG, { force: true });
    await deps.writeTextFile(vercelTsPath, PEER_SERVICE_VERCEL_CONFIG, { force: true });
    await configurePeerServiceScripts(project.environmentRoot, deps);
    await deps.syncHostFrameworkPreset(
      context.presenter,
      project.environmentRoot,
      createPromptCommandOutput(context.presenter.log),
      { signal: context.signal },
    );
    startScript = "dev:services";
  } else {
    await deps.writeTextFile(nextConfigPath, NEXT_HOSTED_CONFIG, { force: true });
    startScript = "dev:web";
  }
  context.presenter.log.success("Configured channel: web");
  return {
    facts: [
      {
        label: "",
        value: `Start locally with \`${runScriptCommand(plan.packageManager, startScript)}\`.`,
      },
    ],
  };
}

export const WEB_SETUP = defineSetupIntegration({
  kind: "web",
  label: "Web Chat",
  hint: "Browser-based chat interface",
  prepare: prepareWebSetup,
  apply: applyWebSetup,
});
