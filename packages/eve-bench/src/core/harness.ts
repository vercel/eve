/**
 * A harness is anything that can be placed in a task container and told to
 * solve an instruction. The runner uploads `bundleDir` to `/installed-agent`,
 * then runs `command` through `sh -c` in the task working directory.
 */
export interface Harness {
  readonly name: string;
  prepare(ctx: HarnessPrepareContext): Promise<HarnessBundle>;
  /** Optional per-task host paths uploaded into the install directory before `command` runs. */
  stage?(ctx: { readonly taskDir: string }): readonly string[];
  command(ctx: HarnessRunContext): string;
  env(ctx: HarnessRunContext): Record<string, string>;
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
