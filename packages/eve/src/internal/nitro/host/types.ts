import type { CompileAgentResult } from "#compiler/compile-agent.js";
import type { ScheduleRegistration } from "#runtime/schedules/register.js";
import type { ResolvedSchedule } from "#runtime/types.js";
import type { GeneratedCompiledArtifactsFiles } from "#internal/application/compiled-artifacts.js";

/**
 * Route surface included in one programmatic Nitro host build.
 */
export type NitroBuildSurface = "all" | "app" | "flow";

/**
 * Handle returned after starting one Nitro development server.
 */
export interface DevelopmentServerHandle {
  close(): Promise<void>;
  url: string;
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
  schedules: readonly ResolvedSchedule[];
  workflowBuildDir: string;
}
