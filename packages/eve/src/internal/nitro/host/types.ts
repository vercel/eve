import type { CompileAgentResult } from "#compiler/compile-agent.js";
import type { ScheduleRegistration } from "#runtime/schedules/register.js";
import type { ResolvedScheduleDefinition } from "#runtime/types.js";
import type { GeneratedCompiledArtifactsFiles } from "#internal/application/compiled-artifacts.js";
import type { DevBootProgressReporter } from "#internal/dev-boot-progress.js";
import type { DevelopmentGeneration } from "#internal/nitro/development-generation.js";
import type { DevelopmentHostWorkspace } from "#internal/nitro/host/dev-host-workspace.js";

/**
 * Route surface included in one programmatic Nitro host build.
 */
export type NitroBuildSurface = "all" | "app" | "flow";

/** Options for one production application build. */
export interface ApplicationBuildOptions {
  readonly skipVercelSandboxPrewarm: boolean;
  readonly vercelServiceOutput?: {
    readonly hostOutputDirectory: string;
    readonly serviceOutputDirectory: string;
  };
}

/** Outcome of starting a Nitro development server the current process owns. */
export interface StartedDevelopmentServer {
  readonly kind: "started";
  readonly appRoot: string;
  readonly url: string;
}

/** A live development server owned by another process. */
export interface ExistingDevelopmentServer {
  readonly kind: "existing";
  readonly appRoot: string;
  readonly url: string;
}

/** Result of starting a development server for an app root. */
export type DevelopmentServerHandle = StartedDevelopmentServer | ExistingDevelopmentServer;

/**
 * Lifecycle for one in-process Nitro development server.
 *
 * `start()` either boots a server this process owns or attaches to a running
 * owner; the {@link DevelopmentServerHandle} result discriminates which.
 * `close()` waits for an in-progress `start()`, then tears down only a server
 * this instance started. It resolves after startup cleanup when `start()`
 * fails, and is a no-op when the instance attached to an existing owner or was
 * never started.
 */
export interface DevelopmentServer<H extends DevelopmentServerHandle = DevelopmentServerHandle> {
  start(): Promise<H>;
  close(): Promise<void>;
}

export interface DevelopmentServerOptions {
  readonly existing?: "attach-if-unconfigured" | "reject";
  readonly host?: string;
  readonly onBootProgress?: DevBootProgressReporter;
  readonly port?: number;
}

/**
 * Handle returned after starting one built Nitro server.
 */
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
  workspace: DevelopmentHostWorkspace;
}
