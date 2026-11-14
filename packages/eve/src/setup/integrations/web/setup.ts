import { join } from "node:path";

import type { RegistrySetupCompletion } from "#setup/registry-setup-protocol.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import type { PackageManagerKind } from "#setup/package-manager.js";
import { WEB_APP_TANSTACK_TEMPLATE_FILES } from "#setup/scaffold/create/web-template.js";
import { installScaffoldDependencies } from "../shared/scaffold.js";
import { prepareWebAuthScaffold } from "./auth-scaffold.js";
import { WEB_AUTHENTICATION_QUESTION } from "./auth-options.js";
import { detectWebChatFramework, type WebChatFramework } from "./framework.js";
import {
  FRAMEWORK_HOSTED_CONFIGS,
  NEXT_HOSTED_CONFIG,
  TANSTACK_HOSTED_VITE_CONFIG,
} from "./hosted-config.js";
import {
  defaultWebChatHostingDeps,
  peerServiceVercelConfig,
  prepareWebChatHosting,
  resolveWebChatProject,
  runScriptCommand,
  type WebChatHostingDeps,
} from "./hosting.js";
import { provisionWebChatAuth } from "./provision-auth.js";
import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";

const PEER_SERVICE_NEXT_CONFIG = `import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
`;
const REGISTRY_NEXT_CONFIG = `import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {};

export default withEve(nextConfig);
`;
const NEXT_PEER_SERVICE_VERCEL_CONFIG = peerServiceVercelConfig(
  "nextjs",
  "node ../../node_modules/next/dist/bin/next build",
);
const LEGACY_NEXT_PEER_SERVICE_VERCEL_CONFIG = NEXT_PEER_SERVICE_VERCEL_CONFIG.replace(
  /    web: \{[^}]+\},/,
  '    web: { framework: "nextjs", root: "apps/web" },',
);

const TANSTACK_REGISTRY_VITE_CONFIG = WEB_APP_TANSTACK_TEMPLATE_FILES["vite.config.ts"];
const TANSTACK_PEER_SERVICE_VERCEL_CONFIG = peerServiceVercelConfig(
  "tanstack-start",
  "node ../../node_modules/vite/bin/vite.js build",
);

/** Every `vercel.ts` the installer has written, so switching frameworks may replace it. */
const INSTALLER_VERCEL_CONFIGS = [
  NEXT_PEER_SERVICE_VERCEL_CONFIG,
  LEGACY_NEXT_PEER_SERVICE_VERCEL_CONFIG,
  TANSTACK_PEER_SERVICE_VERCEL_CONFIG,
];

export interface WebSetupDeps extends WebChatHostingDeps {
  prepareWebAuthScaffold: typeof prepareWebAuthScaffold;
  provisionWebChatAuth: typeof provisionWebChatAuth;
  installScaffoldDependencies: typeof installScaffoldDependencies;
}

const defaultWebSetupDeps: WebSetupDeps = {
  ...defaultWebChatHostingDeps,
  prepareWebAuthScaffold,
  provisionWebChatAuth,
  installScaffoldDependencies,
};

interface WebSetupPlan {
  framework: WebChatFramework;
  hosting: WebChatFramework | "vercel";
  packageManager: PackageManagerKind;
  authProject?: VercelProjectReference;
  rootWebChat?: boolean;
}

/** Whether an earlier install set up `webRoot` to host the agent in the app. */
async function hostsAgentInApp(
  framework: WebChatFramework,
  webRoot: string,
  deps: WebSetupDeps,
): Promise<boolean> {
  const { file, source } = FRAMEWORK_HOSTED_CONFIGS[framework];
  const path = join(webRoot, file);
  return (await deps.pathExists(path)) && (await deps.readTextFile(path)) === source;
}

export async function prepareWebSetup(
  context: SetupPrepareContext,
  deps: WebSetupDeps = defaultWebSetupDeps,
): Promise<WebSetupPlan> {
  const project = await resolveWebChatProject(context.appRoot, deps);
  const webAppRoot = join(project.environmentRoot, "apps", "web");
  // `eve add channel/web` installed the framework's files, so they decide it.
  const framework = (await detectWebChatFramework(webAppRoot, deps.pathExists)) ?? "next";
  const rootWebChat =
    framework === "next" &&
    (await deps.pathExists(join(project.environmentRoot, "app", "eve-agent.ts"))) &&
    !(await deps.pathExists(join(webAppRoot, "app", "eve-agent.ts")));
  // Web Chat deploys as Vercel services. A root Next.js app already hosts the
  // agent, and a rerun keeps an app that was set up to host it, except a
  // TanStack workspace member: `eveTanStack()` mounts one agent.
  const canHostInApp = framework === "next" || project.agentName === undefined;
  const hosting =
    rootWebChat || (canHostInApp && (await hostsAgentInApp(framework, webAppRoot, deps)))
      ? framework
      : "vercel";
  // Sign in with Vercel ships as Next.js files.
  const authentication =
    framework === "next" ? await context.asker.ask(WEB_AUTHENTICATION_QUESTION) : "custom";
  const authProject =
    authentication === "vercel"
      ? await context.resolveVercelProject("Web Chat sign-in")
      : undefined;
  const plan: WebSetupPlan = {
    framework,
    hosting,
    packageManager: (await deps.detectPackageManager(project.environmentRoot)).kind,
  };
  if (authProject !== undefined) plan.authProject = authProject;
  if (rootWebChat) plan.rootWebChat = true;
  return plan;
}

function hostConfig(plan: WebSetupPlan, webRoot: string) {
  const vercelServices = plan.hosting === "vercel";
  if (plan.framework === "tanstack") {
    return {
      path: join(webRoot, "vite.config.ts"),
      source: vercelServices ? TANSTACK_REGISTRY_VITE_CONFIG : TANSTACK_HOSTED_VITE_CONFIG,
      owned: [TANSTACK_REGISTRY_VITE_CONFIG, TANSTACK_HOSTED_VITE_CONFIG],
    };
  }
  const hostedNextConfig = plan.rootWebChat ? REGISTRY_NEXT_CONFIG : NEXT_HOSTED_CONFIG;
  return {
    path: join(webRoot, "next.config.ts"),
    source: vercelServices ? PEER_SERVICE_NEXT_CONFIG : hostedNextConfig,
    owned: [REGISTRY_NEXT_CONFIG, NEXT_HOSTED_CONFIG, PEER_SERVICE_NEXT_CONFIG],
  };
}

export async function applyWebSetup(
  plan: WebSetupPlan,
  context: SetupApplyContext,
  deps: WebSetupDeps = defaultWebSetupDeps,
) {
  const project = await resolveWebChatProject(context.appRoot, deps);
  const webRoot = plan.rootWebChat
    ? project.environmentRoot
    : join(project.environmentRoot, "apps", "web");
  const writeAuth =
    plan.authProject === undefined
      ? undefined
      : await deps.prepareWebAuthScaffold({
          environmentRoot: project.environmentRoot,
          agentAppRoot: project.agentAppRoot,
          webRoot,
          force: context.force,
        });
  const vercelServices = plan.hosting === "vercel";
  const vercelConfig =
    plan.framework === "tanstack"
      ? TANSTACK_PEER_SERVICE_VERCEL_CONFIG
      : NEXT_PEER_SERVICE_VERCEL_CONFIG;
  const writeHosting = await prepareWebChatHosting(
    {
      project,
      webRoot,
      force: context.force,
      writeChannel: writeAuth === undefined,
      hostConfig: hostConfig(plan, webRoot),
      vercelServices,
      vercelConfigs: [
        vercelConfig,
        ...INSTALLER_VERCEL_CONFIGS.filter((config) => config !== vercelConfig),
      ],
    },
    deps,
  );
  await writeHosting();
  const startScript = vercelServices ? "dev:all" : plan.rootWebChat ? "dev" : "dev:web";
  if (plan.authProject !== undefined && writeAuth !== undefined) {
    await deps.provisionWebChatAuth(plan.authProject, context.signal);
    context.signal?.throwIfAborted();
    await writeAuth();
    await deps.installScaffoldDependencies({
      changed: true,
      log: context.presenter.log,
      projectPath: project.environmentRoot,
      signal: context.signal,
    });
    context.presenter.log.success("Configured Sign in with Vercel for this project's team");
    context.presenter.nextSteps([
      "Local setup is complete. Run `eve deploy` to publish these changes. Production and preview credentials are configured.",
      "Local development continues to use localDev() without signing in.",
    ]);
  }
  context.presenter.log.success("Configured channel: web");
  const completion: RegistrySetupCompletion = {
    facts: [
      {
        label: "",
        value: `Start locally with \`${runScriptCommand(plan.packageManager, startScript)}\`.`,
      },
    ],
  };
  if (plan.authProject !== undefined) completion.deploymentRequired = true;
  return completion;
}

export const WEB_SETUP = defineSetupIntegration({
  kind: "web",
  label: "Web Chat",
  hint: "Browser-based chat interface",
  prepare: prepareWebSetup,
  apply: applyWebSetup,
});
