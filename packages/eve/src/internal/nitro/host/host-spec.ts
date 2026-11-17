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
      readonly publicRoutePrefix?: string;
      readonly workspaceMember?: boolean;
    };

export interface HostDirectories {
  readonly buildDir: string;
  readonly outputDir: string;
}

export type HostRuntimePlugin =
  | "instrumentation"
  | "local-schedules"
  | "sandbox-shutdown"
  | "skill-files";

export interface HostSpec {
  readonly agentName: string;
  readonly authored: HostAuthoredSources;
  readonly development: boolean;
  readonly extensionMounts: readonly CompiledExtensionMount[];
  readonly extensionOverridePaths: ReadonlyMap<string, string>;
  readonly externals: ExternalsPolicy;
  readonly instrumented: boolean;
  readonly preset: "vercel" | undefined;
  readonly routes: HostRouteTable;
  readonly runtime: HostRuntime;
  readonly runtimePlugins: readonly HostRuntimePlugin[];
  readonly skills: readonly string[];
  readonly vercel: ReturnType<typeof createEveVercelOptions>;
  readonly websocket: boolean;
  readonly world: AgentWorkflowWorldDefinition | undefined;
  readonly locations: HostLocations;
}

interface HostAuthoredSources {
  readonly packageRoot: string;
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

function hasWorkflowProgram(manifest: CompiledAgentManifest): boolean {
  const nodes = [manifest, ...manifest.subagents.map((subagent) => subagent.agent)];
  return nodes.some((node) => node.tools.some((tool) => tool.workflowProgram !== undefined));
}
