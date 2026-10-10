import { join } from "node:path";

import { select } from "#setup/ask.js";
import type { RegistrySetupCompletion } from "#setup/registry-setup-protocol.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import type { PackageManagerKind } from "#setup/package-manager.js";
import { WEB_APP_TANSTACK_TEMPLATE_FILES } from "#setup/scaffold/create/web-template.js";
import { installScaffoldDependencies } from "../shared/scaffold.js";
import { prepareWebAuthScaffold } from "./auth-scaffold.js";
import { WEB_AUTHENTICATION_QUESTION } from "./auth-options.js";
import {
  detectWebChatFramework,
  WEB_CHAT_FRAMEWORK_LABELS,
  type WebChatFramework,
} from "./framework.js";
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
const TANSTACK_HOSTED_VITE_CONFIG = `import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { eveTanStack } from "eve/tanstack";
import { nitro } from "nitro/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const eveRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    eveTanStack({ eveRoot }),
    tailwindcss(),
    tanstackStart({ srcDirectory: "app" }),
    viteReact(),
    nitro(),
  ],
});
`;
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

function hostingQuestion(framework: WebChatFramework) {
  const label = WEB_CHAT_FRAMEWORK_LABELS[framework];
  return select<WebChatFramework | "vercel">({
    key: "web-hosting",
    message: "How should Web Chat and your agents be deployed?",
    options: [
      {
        id: "vercel",
        label: "Vercel services",
        hint: "(Recommended) Web Chat and agents deploy as separate services.",
        value: "vercel",
      },
      {
        id: framework,
        label,
        hint: `One ${label} app serves Web Chat and routes agent requests.`,
        value: framework,
      },
    ],
    recommended: "vercel",
    required: true,
  });
}

export async function prepareWebSetup(
  context: SetupPrepareContext,
  deps: WebSetupDeps = defaultWebSetupDeps,
): Promise<WebSetupPlan> {
  const project = await resolveWebChatProject(context.appRoot, deps);
  // `eve add channel/web` installed the framework's files, so they decide it.
  const framework =
    (await detectWebChatFramework(join(project.environmentRoot, "apps", "web"), deps.pathExists)) ??
    "next";
  const rootWebChat =
    framework === "next" &&
    (await deps.pathExists(join(project.environmentRoot, "app", "eve-agent.ts"))) &&
    !(await deps.pathExists(join(project.environmentRoot, "apps", "web", "app", "eve-agent.ts")));
  // `eveTanStack()` mounts one agent, so a TanStack workspace member deploys as a peer service.
  const hosting = rootWebChat
    ? "next"
    : framework === "tanstack" && project.agentName !== undefined
      ? "vercel"
      : await context.asker.ask(hostingQuestion(framework));
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
