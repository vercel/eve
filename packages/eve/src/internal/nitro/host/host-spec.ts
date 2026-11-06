import { join } from "node:path";

import { extensionOverridePaths } from "#compiler/extension-mount-bindings.js";
import type { CompiledAgentManifest, CompiledExtensionMount } from "#compiler/manifest.js";
import type { GeneratedCompiledArtifactsFiles } from "#internal/application/compiled-artifacts.js";
import { findAuthoredPackageRoot } from "#internal/authored-package-boundary.js";
import { resolveAuthoredTsConfigPath } from "#internal/bundler/authored-plugins.js";
import {
  createExternalsPolicy,
  type ExternalsPolicy,
} from "#internal/nitro/host/externals-policy.js";
import { createHostRouteTable, type HostRouteTable } from "#internal/nitro/host/host-routes.js";
import type { PreparedApplicationHost } from "#internal/nitro/host/types.js";
import type { HostRuntime } from "#internal/nitro/host/runtime-plugin.js";
import { createEveVercelOptions } from "#internal/nitro/host/vercel-build-output-config.js";
import { usesLocalVercelSchedules } from "#internal/schedules/consumer-route.js";
import type { AgentWorkflowWorldDefinition } from "#shared/agent-definition.js";

export type HostMode =
  | { readonly kind: "development" }
  | {
      readonly kind: "production";
      readonly preset: "vercel" | undefined;
      /**
       * The agent's public route prefix, baked into the Vercel flow function
       * so callback URLs resolve behind a per-agent mount.
       */
      readonly publicRoutePrefix?: string;
      readonly workspaceMember?: boolean;
    };

export interface HostDirectories {
  readonly buildDir: string;
  readonly outputDir: string;
}

/** Nitro runtime plugins eve installs after its own runtime plugin, in load order. */
export type HostRuntimePlugin =
  | "instrumentation"
  | "local-schedules"
  | "sandbox-shutdown"
  | "skill-files";

/** Everything eve's Nitro host serves and bundles, derived from the compiled agent. */
export interface HostSpec {
  readonly agentName: string;
  /** How the host bundles authored sources. */
  readonly authored: HostAuthoredSources;
  readonly development: boolean;
  readonly extensionMounts: readonly CompiledExtensionMount[];
  /** Authored files that override an extension mount's bindings, keyed to the mount id. */
  readonly extensionOverridePaths: ReadonlyMap<string, string>;
  readonly externals: ExternalsPolicy;
  /** Wraps the server entry so authored instrumentation finishes setup first. */
  readonly instrumented: boolean;
  readonly preset: "vercel" | undefined;
  readonly routes: HostRouteTable;
  /** What eve's generated runtime plugin installs. */
  readonly runtime: HostRuntime;
  readonly runtimePlugins: readonly HostRuntimePlugin[];
  /** Skills a production build embeds; dev reads the compile directory. */
  readonly skills: readonly string[];
  readonly vercel: ReturnType<typeof createEveVercelOptions>;
  readonly websocket: boolean;
  /** The configured Workflow world; unset selects the local world. */
  readonly world: AgentWorkflowWorldDefinition | undefined;
  /** Where the host's inputs and outputs live. Nothing here changes what the host does. */
  readonly locations: HostLocations;
}

interface HostAuthoredSources {
  /** Package root authored asset imports may not escape. */
  readonly packageRoot: string;
  /** The authored package's tsconfig or jsconfig, which resolves authored import aliases. */
  readonly tsconfig: string | false;
}

interface HostLocations {
  readonly appRoot: string;
  readonly buildDir: string;
  readonly compiledArtifacts: GeneratedCompiledArtifactsFiles;
  readonly outputDir: string;
  readonly skillsRoot: string;
  readonly workflowBuildDir: string;
}

export function createHostSpec(
  preparedHost: PreparedApplicationHost,
  mode: HostMode,
  dirs: HostDirectories,
): HostSpec {
  const { appRoot, compiledArtifacts } = preparedHost;
  const { manifest, paths } = preparedHost.compileResult;
  // A workspace member without its own package.json shares the enclosing package.
  const packageRoot = findAuthoredPackageRoot(appRoot) ?? appRoot;
  const development = mode.kind === "development";
  const preset = mode.kind === "production" ? mode.preset : undefined;
  const instrumented = compiledArtifacts.instrumentationPluginPath !== undefined;
  const nodes = [manifest, ...manifest.subagents.map((subagent) => subagent.agent)];
  const routes = createHostRouteTable({
    manifest,
    mode: mode.kind,
    scheduleRegistrations: preparedHost.scheduleRegistrations,
    vercel: preset === "vercel",
  });
  const runtimePlugins: HostRuntimePlugin[] = [
    ...(development ? [] : (["skill-files"] as const)),
    ...(instrumented ? (["instrumentation"] as const) : []),
    ...(development && usesLocalVercelSchedules(manifest) ? (["local-schedules"] as const) : []),
    ...(development ? [] : (["sandbox-shutdown"] as const)),
  ];

  return {
    agentName: manifest.config.name,
    authored: { packageRoot, tsconfig: resolveAuthoredTsConfigPath(packageRoot) },
    development,
    extensionMounts: nodes.flatMap((node) => node.extensionMounts),
    extensionOverridePaths: extensionOverridePaths(manifest),
    externals: createExternalsPolicy({ development, manifest, preset }),
    instrumented,
    locations: {
      appRoot,
      buildDir: dirs.buildDir,
      compiledArtifacts,
      outputDir: dirs.outputDir,
      skillsRoot: join(
        paths.compileDirectoryPath,
        manifest.workspaceResourceRoot.logicalPath,
        "skills",
      ),
      workflowBuildDir: preparedHost.workflowBuildDir,
    },
    preset,
    routes,
    runtime: {
      localTracing: development && !instrumented,
      workflowSandbox: hasWorkflowProgram(manifest),
    },
    runtimePlugins,
    skills: development ? [] : manifest.skills.map((skill) => skill.name),
    vercel: createEveVercelOptions({
      agentName: manifest.config.name,
      enabled: preset === "vercel",
      publicRoutePrefix: mode.kind === "production" ? mode.publicRoutePrefix : undefined,
      routeTable: routes,
      workspaceMember: mode.kind === "production" ? mode.workspaceMember : undefined,
    }),
    websocket: development || routes.routes.some((route) => route.method === "WEBSOCKET"),
    world: manifest.config.experimental?.workflow?.world,
  };
}

/** Whether any agent exposes a generated-program tool that needs the workflow sandbox runtime. */
function hasWorkflowProgram(manifest: CompiledAgentManifest): boolean {
  const nodes = [manifest, ...manifest.subagents.map((subagent) => subagent.agent)];
  return nodes.some((node) => node.tools.some((tool) => tool.workflowProgram !== undefined));
}
