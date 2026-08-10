import { interactiveAsker, withAnswers } from "../ask.js";
import { linkVercelProject, type LinkProjectDeps } from "../boxes/link-project.js";
import {
  resolveProvisioning,
  type ResolveProvisioningDeps,
} from "../boxes/resolve-provisioning.js";
import type { Prompter } from "../prompter.js";
import { readProjectLink, type VercelProjectReference } from "../project-resolution.js";
import { runInteractive, type AnySetupBox } from "../runner.js";
import { snapshotSetupState, type SetupState } from "../state.js";
import { WizardCancelledError } from "../step.js";
import { inProjectSetupState, prompterSink } from "./in-project.js";

export interface EnsureVercelProjectDeps {
  resolveProvisioning?: ResolveProvisioningDeps;
  linkProject?: LinkProjectDeps;
  readProjectLink: typeof readProjectLink;
}

/** Ensures a project link using eve-owned prompts and a non-interactive Vercel command. */
export async function ensureVercelProject(input: {
  appRoot: string;
  prompter: Prompter;
  signal?: AbortSignal;
  /**
   * Headless runs never open the interactive linking flow below: an existing
   * link is returned and a missing link fails, so the caller completes this
   * shared one-time prerequisite separately.
   */
  headless?: boolean;
  teamSelectMessage?: (currentTeam: string) => string;
  deps?: Partial<EnsureVercelProjectDeps>;
}): Promise<VercelProjectReference> {
  const readLink = input.deps?.readProjectLink ?? readProjectLink;
  const existing = await readLink(input.appRoot);
  if (existing !== undefined) return existing;

  if (input.headless) {
    throw new Error(
      "This project is not linked to a Vercel project, and headless setup cannot open the interactive linking flow. Link the project separately, then retry.",
    );
  }

  const state = inProjectSetupState(input.appRoot, { kind: "unresolved" });
  const boxes: AnySetupBox<SetupState>[] = [
    resolveProvisioning({
      asker: withAnswers({ deploy: "vercel" })(interactiveAsker(input.prompter)),
      prompter: input.prompter,
      targetDirectory: input.appRoot,
      mode: { headless: false },
      adoptExistingLink: false,
      projectSelection: "create-or-link",
      teamSelectMessage: input.teamSelectMessage,
      deps: input.deps?.resolveProvisioning,
    }),
    linkVercelProject({ prompter: input.prompter, deps: input.deps?.linkProject }),
  ];
  const result = await runInteractive(boxes, state, prompterSink(input.prompter), {
    snapshot: snapshotSetupState,
    signal: input.signal,
  });
  if (result.kind === "cancelled") {
    input.signal?.throwIfAborted();
    throw new WizardCancelledError();
  }

  const linked = await readLink(input.appRoot);
  if (linked === undefined) throw new Error("Vercel project linking failed.");
  return linked;
}
