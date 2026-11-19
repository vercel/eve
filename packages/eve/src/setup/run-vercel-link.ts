import { runVercel, type RunVercelOptions } from "#setup/primitives/index.js";

type VercelOutputHandler = NonNullable<RunVercelOptions["onOutput"]>;

export async function runVercelEnvPull(
  projectRoot: string,
  onOutput?: VercelOutputHandler,
  signal?: AbortSignal,
  nonInteractive = false,
): Promise<boolean> {
  return runVercel(["env", "pull", "--yes"], {
    cwd: projectRoot,
    nonInteractive,
    onOutput,
    signal,
  });
}
