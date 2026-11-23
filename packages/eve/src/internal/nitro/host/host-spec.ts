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
import type { BuildContribution } from "#execution/durable.js";
import { isWorkflowEngineBuild, WORKFLOW_ENGINE_BUILD } from "#execution/workflow-host/build.js";
import { createHostRouteTable, type HostRouteTable } from "#internal/nitro/host/host-routes.js";
import type { PreparedApplicationHost } from "#internal/nitro/host/types.js";
import type { HostRuntime } from "#internal/nitro/host/runtime-plugin.js";
import type { PlatformBuildOutput, PlatformNitroOptions } from "#platform/types.js";
import type { AgentWorkflowWorldDefinition } from "#shared/agent-definition.js";

export type HostMode =
  | { readonly kind: "development" }
  | {
      readonly kind: "production";
      readonly preset: "vercel" | undefined;
      readonly entry?: string;
      readonly conditions?: readonly string[];
      readonly publicRoutePrefix?: string;
      readonly vercelService?: boolean;
      readonly workspaceMember?: boolean;
    };

export interface HostDirectories {
  readonly buildDir: string;
  readonly outputDir: string;
}

export type HostRuntimePlugin =
  | "connection-drain"
  | "instrumentation"
  | "local-schedules"
  | "timezone-schedules"
  | "sandbox-shutdown"
  | "skill-files";

export interface HostSpec {
  readonly agentName: string;
  readonly authored: HostAuthoredSources;
  readonly development: boolean;
  readonly entry: string | undefined;
  readonly exportConditions: readonly string[] | undefined;
  readonly extensionMounts: readonly CompiledExtensionMount[];
  readonly extensionOverridePaths: ReadonlyMap<string, string>;
  readonly externals: ExternalsPolicy;
  readonly instrumented: boolean;
  readonly localSchedulesPluginModulePath: string;
  readonly preset: "vercel" | "standard" | undefined;
  readonly routes: HostRouteTable;
  readonly runtime: HostRuntime;
  readonly runtimePlugins: readonly HostRuntimePlugin[];
  readonly skills: readonly string[];
  readonly vercel: PlatformNitroOptions;
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
  platform: PlatformBuildOutput,
): HostSpec {
  const { appRoot, compiledArtifacts } = preparedHost;
  const { manifest, paths } = preparedHost.compileResult;
  const packageRoot = findAuthoredPackageRoot(appRoot) ?? appRoot;
  const development = mode.kind === "development";
  const entry = mode.kind === "production" ? mode.entry : undefined;
  const preset =
    mode.kind === "production"
      ? (mode.preset ?? (entry === undefined ? undefined : "standard"))
      : undefined;
  const instrumented = compiledArtifacts.instrumentationPluginPath !== undefined;
  const nodes = [manifest, ...manifest.subagents.map((subagent) => subagent.agent)];
  assertEngineBuilds(manifest, WORKFLOW_ENGINE_BUILD);
  const routes = createHostRouteTable({
    durable: WORKFLOW_ENGINE_BUILD,
    manifest,
    mode: mode.kind,
    platform,
    scheduleRegistrations: preparedHost.scheduleRegistrations,
    vercel: preset === "vercel",
    vercelService: mode.kind === "production" && mode.vercelService === true,
  });
  if (entry !== undefined) assertEntryCanServe(manifest, routes);
  const conditions = mode.kind === "production" ? mode.conditions : undefined;
  if (conditions !== undefined && entry === undefined) {
    throw new Error(
      "A platform's `build.conditions` needs `build.entry`, because eve's own Node server runs with Node's export conditions. Add `build.entry` or remove `build.conditions`.",
    );
  }
  const runtimePlugins: HostRuntimePlugin[] = [
    ...(development ? [] : (["skill-files"] as const)),
    ...(instrumented ? (["instrumentation"] as const) : []),
    ...(development && platform.schedules.usesLocal(manifest)
      ? (["local-schedules"] as const)
      : []),
    ...(!development &&
    preset !== "vercel" &&
    routes.scheduleTasks.some((task) => task.timezone !== undefined)
      ? (["timezone-schedules"] as const)
      : []),
    ...(development ? [] : (["sandbox-shutdown"] as const)),
    ...(!development && preset === undefined ? (["connection-drain"] as const) : []),
  ];

  return {
    agentName: manifest.config.name,
    authored: { packageRoot, tsconfig: resolveAuthoredTsConfigPath(packageRoot) },
    development,
    entry,
    exportConditions: conditions,
    extensionMounts: nodes.flatMap((node) => node.extensionMounts),
    extensionOverridePaths: extensionOverridePaths(manifest),
    externals: createExternalsPolicy({
      development,
      manifest,
      preset: preset === "vercel" ? preset : undefined,
    }),
    instrumented,
    localSchedulesPluginModulePath: platform.schedules.localPluginModulePath(),
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
    vercel: platform.nitroOptions({
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

function assertEntryCanServe(manifest: CompiledAgentManifest, routes: HostRouteTable): void {
  const websocket = manifest.channelRoutes.effective.find((route) => route.method === "WEBSOCKET");
  if (websocket !== undefined) {
    throw new Error(
      `A WEBSOCKET channel route needs eve's Node server: WEBSOCKET ${websocket.urlPath} in "${websocket.logicalPath}". Remove the route or build without \`build.entry\`.`,
    );
  }
  const schedule = routes.scheduleTasks[0];
  if (schedule !== undefined) {
    throw new Error(
      `Authored schedules aren't supported with \`Build.entry\` yet: schedule "${schedule.scheduleId}" in "${schedule.logicalPath}". Remove the schedule or build without \`build.entry\`. Dynamic schedules through the platform's \`Triggers\` are supported.`,
    );
  }
}

export function assertEngineBuilds(
  manifest: CompiledAgentManifest,
  durable: BuildContribution,
): void {
  if (hasAuthoredWorkflows(manifest) && durable.runs !== true) {
    throw new Error(
      "This agent has authored workflows, and its durable engine can't run them. Remove the workflow tools, or use an engine that runs workflows, such as the Workflow engine.",
    );
  }
  if (!isWorkflowEngineBuild(durable)) {
    throw new Error(
      "eve builds only the Workflow engine's routes and bundles so far, and this durable engine contributes its own. Use the Workflow engine.",
    );
  }
}

function hasAuthoredWorkflows(manifest: CompiledAgentManifest): boolean {
  const nodes = [manifest, ...manifest.subagents.map((subagent) => subagent.agent)];
  return nodes.some((node) =>
    node.tools.some((tool) => tool.behavior?.handling?.kind === "workflow-tool"),
  );
}

function hasWorkflowProgram(manifest: CompiledAgentManifest): boolean {
  const nodes = [manifest, ...manifest.subagents.map((subagent) => subagent.agent)];
  return nodes.some((node) => node.tools.some((tool) => tool.workflowProgram !== undefined));
}
