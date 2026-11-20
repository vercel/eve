import type { CompileAgentResult } from "#compiler/compile-agent.js";
import type { ScheduleRegistration } from "#runtime/schedules/register.js";
import type { ResolvedScheduleDefinition } from "#runtime/types.js";
import type { GeneratedCompiledArtifactsFiles } from "#internal/application/compiled-artifacts.js";
import type { DevBootProgressReporter } from "#internal/dev-boot-progress.js";
import type { DevelopmentExtensionSelection } from "#compiler/development-extensions.js";
import type { DevelopmentGeneration } from "#internal/nitro/development-generation.js";
import type { DevelopmentHostWorkspace } from "#internal/nitro/host/dev-host-workspace.js";
import type { WorkspaceExtension } from "#internal/nitro/host/workspace-extensions.js";

export interface ApplicationBuildOptions {
  readonly profileOutputPath?: string;
  readonly publicRoutePrefix?: string;
  readonly skipSandboxPrewarm: boolean;
  readonly workspaceMember?: boolean;
  readonly vercelServiceOutput?: {
    readonly hostOutputDirectory: string;
    readonly serviceOutputDirectory: string;
  };
}

export interface StartedDevelopmentServer {
  readonly kind: "started";
  readonly appRoot: string;
  readonly url: string;
}

export interface ExistingDevelopmentServer {
  readonly kind: "existing";
  readonly appRoot: string;
  readonly url: string;
}

export type DevelopmentServerHandle = StartedDevelopmentServer | ExistingDevelopmentServer;

export interface DevelopmentServer<H extends DevelopmentServerHandle = DevelopmentServerHandle> {
  start(): Promise<H>;
  close(): Promise<void>;
}

export interface DevelopmentServerOptions {
  readonly resume?: boolean;
  readonly developmentExtensions?: DevelopmentExtensionSelection;
  readonly existing?: "attach-if-unconfigured" | "reject";
  readonly host?: string;
  readonly onBootProgress?: DevBootProgressReporter;
  readonly output?: "stderr" | "stdout";
  readonly port?: number;
}

export interface ProductionServerHandle {
  close(): Promise<void>;
  url: string;
  wait(): Promise<void>;
}

export interface PreparedApplicationHost {
  appRoot: string;
  compileResult: CompileAgentResult;
  compiledArtifacts: GeneratedCompiledArtifactsFiles;
  scheduleRegistrations: readonly ScheduleRegistration[];
  schedules: readonly ResolvedScheduleDefinition[];
  workflowBuildDir: string;
}

export interface PreparedDevelopmentApplicationHost extends PreparedApplicationHost {
  generation: DevelopmentGeneration;
  workspaceExtensions: readonly WorkspaceExtension[];
  workspace: DevelopmentHostWorkspace;
}
