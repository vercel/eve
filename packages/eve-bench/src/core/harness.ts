import type { Usage } from "./result.ts";

/**
 * A harness is anything that can be placed in a task container and told to
 * solve an instruction. The runner uploads `bundleDir` to `/installed-agent`,
 * then runs `command` through `sh -c` in the task working directory.
 */
export interface Harness {
  readonly name: string;
  /** Host environment names allowed to cross into this harness process. */
  readonly credentials?: readonly string[];
  /** Set when the harness makes no model calls, so missing usage does not invalidate a trial. */
  readonly modelFree?: boolean;
  prepare(ctx: HarnessPrepareContext): Promise<HarnessBundle>;
  /** Optional per-task host paths uploaded into the install directory before `command` runs. */
  stage?(ctx: { readonly taskDir: string }): readonly string[];
  command(ctx: HarnessRunContext): string;
  env(ctx: HarnessRunContext): Record<string, string>;
  /**
   * Reads root-session usage from the downloaded agent logs on the host. It runs
   * after timeouts too, so harnesses should log usage incrementally.
   */
  readUsage?(agentLogsDir: string): Promise<Usage | undefined>;
}

export interface HarnessPrepareContext {
  readonly model: string;
  readonly cacheDir: string;
}

export interface HarnessBundle {
  readonly dir: string;
  /** Architecture-specific host directories uploaded to `${installDir}/arch`. */
  readonly arch?: Readonly<Record<"x64" | "arm64", string>>;
  /** Recorded in results so a run can be traced back to the exact harness build. */
  readonly provenance?: Record<string, unknown>;
}

export interface HarnessRunContext {
  readonly model: string;
  readonly installDir: string;
  readonly instructionPath: string;
  readonly taskWorkdir: string;
  readonly logsDir: string;
}
