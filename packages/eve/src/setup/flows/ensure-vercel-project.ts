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
import { requireAuth } from "../vercel-project.js";
import { checkTeamRequirement, type VercelTeamRequirement } from "../vercel-project-api.js";
import { inProjectSetupState, prompterSink } from "./in-project.js";
import { runLoginFlow } from "./login.js";

export interface EnsureVercelProjectDeps {
  resolveProvisioning?: ResolveProvisioningDeps;
  linkProject?: LinkProjectDeps;
  readProjectLink: typeof readProjectLink;
  requireAuth: typeof requireAuth;
  runLoginFlow: typeof runLoginFlow;
}

/** Ensures Vercel authentication and a project link using eve-owned prompts. */
export async function ensureVercelProject(input: {
  appRoot: string;
  prompter: Prompter;
  signal?: AbortSignal;
  teamSelectMessage?: (currentTeam: string) => string;
  teamRequirement?: VercelTeamRequirement;
  deps?: Partial<EnsureVercelProjectDeps>;
}): Promise<VercelProjectReference> {
  const readLink = input.deps?.readProjectLink ?? readProjectLink;
  const login = await (input.deps?.runLoginFlow ?? runLoginFlow)({
    appRoot: input.appRoot,
    prompter: input.prompter,
    signal: input.signal,
    allowLogin: false,
  });
  if (login.kind === "cancelled") throw new WizardCancelledError();
  if (login.kind !== "already" && login.kind !== "logged-in") {
    await (input.deps?.requireAuth ?? requireAuth)(input.appRoot, input.prompter, {
      signal: input.signal,
    });
  }

  const existing = await readLink(input.appRoot);
  if (existing !== undefined) {
    if (input.teamRequirement) {
      const issue = await checkTeamRequirement(
        input.appRoot,
        existing.orgId,
        input.teamRequirement,
        { signal: input.signal },
      );
      if (issue)
        throw new Error(
          `Cannot configure the linked Vercel team. ${issue} Run \`eve link\` to choose another team, or ask its owner to finish setup.`,
        );
    }
    return existing;
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
      teamRequirement: input.teamRequirement,
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
