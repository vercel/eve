import type { SandboxConnection, SandboxJson } from "#public/sandbox/provider.js";
import type { VercelSandboxSession } from "#public/sandbox/vercel.js";

/** What {@link rebuildSandboxTemplate} needs to refresh the agent's Vercel sandbox template. */
export interface SandboxTemplateRebuildInput {
  /**
   * Updates the files in a throwaway sandbox opened from the current template. If it throws, the
   * template stays as it was.
   */
  readonly prepare: (sandbox: VercelSandboxSession) => Promise<void>;
  /**
   * An opaque label for what `prepare` brings in, such as a commit. A template already built with
   * this revision is left alone.
   */
  readonly revision: string;
}

/** The outcome of {@link rebuildSandboxTemplate}. */
export interface SandboxTemplateRebuildResult {
  /**
   * `true` when new sessions now open from the rebuilt template. `false` when the template
   * already had this revision or another rebuild is running or published first.
   */
  readonly rebuilt: boolean;
}

export interface SandboxTemplateRebuilderInput {
  readonly prepare: (
    connection: SandboxConnection<Pick<VercelSandboxSession, "name" | "setNetworkPolicy">>,
  ) => Promise<void>;
  readonly revision: string;
}

type SandboxTemplateRebuilder = (
  artifact: SandboxJson,
  input: SandboxTemplateRebuilderInput,
) => Promise<SandboxTemplateRebuildResult>;

const rebuilders = new WeakMap<object, SandboxTemplateRebuilder>();

export function withSandboxTemplateRebuilder<Implementation extends object>(
  implementation: Implementation,
  rebuild: SandboxTemplateRebuilder,
): Implementation {
  rebuilders.set(implementation, rebuild);
  return implementation;
}

export function getSandboxTemplateRebuilder(
  implementation: object,
): SandboxTemplateRebuilder | undefined {
  return rebuilders.get(implementation);
}
