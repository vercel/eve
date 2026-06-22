import { interactiveAsker, withAnswers } from "../ask.js";
import { AI_GATEWAY_API_KEY_ENV_VAR } from "../ai-gateway-api-key.js";
import {
  applyAiGatewayCredential,
  type ApplyAiGatewayCredentialDeps,
} from "../boxes/apply-ai-gateway-credential.js";
import { detectAiGateway, findEnvFileWithKey } from "../boxes/detect-ai-gateway.js";
import { linkVercelProject, type LinkProjectDeps } from "../boxes/link-project.js";
import {
  resolveProvisioning,
  type ResolveProvisioningDeps,
} from "../boxes/resolve-provisioning.js";
import { detectProjectIdentity } from "../project-resolution.js";
import type { Prompter } from "../prompter.js";
import { WizardCancelledError } from "../step.js";
import { runInteractive, type AnySetupBox } from "../runner.js";
import { snapshotSetupState, type SetupState } from "../state.js";
import { withSpinner } from "../with-spinner.js";
import pc from "picocolors";

import { inProjectSetupState, prompterSink } from "./in-project.js";

/** Injected for tests; defaults to the real detection and box effects. */
export interface LinkFlowDeps {
  detectProjectIdentity: typeof detectProjectIdentity;
  findEnvFileWithKey: typeof findEnvFileWithKey;
  resolveProvisioning?: ResolveProvisioningDeps;
  linkProject?: LinkProjectDeps;
  applyAiGatewayCredential?: ApplyAiGatewayCredentialDeps;
}

export type LinkFlowResult =
  | {
      kind: "done";
      /** The model credential verified in an env file, when one landed. */
      credential?: "VERCEL_OIDC_TOKEN" | typeof AI_GATEWAY_API_KEY_ENV_VAR;
    }
  | { kind: "cancelled" };

/**
 * THE LINK FLOW, shared by `eve link` and the dev TUI `/model` menu's provider row (its
 * "Connect via a project" branch): the same
 * team/project pickers onboarding uses, then the actual `vercel link`, then a
 * `vercel env pull` so the AI Gateway credential lands in `.env.local`.
 *
 * Re-link semantics: an already-linked directory shows its current link as a
 * gate — one "Link to another project" option; Esc keeps the link and folds
 * to cancelled — and only then runs the pickers. The new choice is
 * authoritative (the state seeds an unresolved project so no stale link leaks
 * into the boxes). Reaching this flow IS the "use Vercel" decision, so
 * resolve-provisioning's deploy gate is pre-answered.
 *
 * Ends by verifying a model credential actually landed (`VERCEL_OIDC_TOKEN`
 * or `AI_GATEWAY_API_KEY` in an env file) — an env pull can succeed without
 * granting gateway access, and the difference is what the user acts on next.
 */
export async function runLinkFlow(input: {
  appRoot: string;
  prompter: Prompter;
  signal?: AbortSignal;
  /**
   * Whether the caller may only link an existing project (`eve link`, the
   * default) or may also create one (the `/model` "Connect via a project"
   * branch, where a fresh agent has no project yet).
   */
  projectSelection?: "create-or-link" | "existing-only";
  deps?: Partial<LinkFlowDeps>;
}): Promise<LinkFlowResult> {
  const { appRoot, prompter, signal, projectSelection = "existing-only" } = input;
  const deps: LinkFlowDeps = {
    detectProjectIdentity,
    findEnvFileWithKey,
    ...input.deps,
  };

  const identity = await withSpinner(prompter, "Checking the current Vercel link...", async () => {
    const detected = await deps.detectProjectIdentity(appRoot, { signal });
    signal?.throwIfAborted();
    return detected;
  });
  if (identity === undefined) {
    // A working model is NOT evidence of a link — credentials can come from
    // an env file or the shell. Naming the source heads off "but it clearly
    // works" confusion when the link detection correctly says unlinked.
    const [gatewayKey, oidc] = await Promise.all([
      deps.findEnvFileWithKey(appRoot, AI_GATEWAY_API_KEY_ENV_VAR),
      deps.findEnvFileWithKey(appRoot, "VERCEL_OIDC_TOKEN"),
    ]);
    const credentialFile = gatewayKey ?? oidc;
    if (credentialFile !== undefined) {
      prompter.log.message(
        `This directory is not linked to a Vercel project yet — the model currently runs on credentials from ${credentialFile}.`,
      );
    }
  } else {
    const where =
      identity.teamName === undefined
        ? pc.bold(identity.projectName)
        : `${pc.bold(identity.projectName)} in ${pc.bold(identity.teamName)}`;
    try {
      const choice = await prompter.select<"relink" | "dismiss">({
        message: `This directory is already linked to\n${where}`,
        options: [
          {
            value: "relink",
            label: "Link to another project",
          },
          { value: "dismiss", label: "Dismiss" },
        ],
      });
      if (choice === "dismiss") return { kind: "cancelled" };
    } catch (error) {
      // Keeping the current link is a clean outcome, not a failure — fold the
      // cancel here so the CLI command never paints it as an error.
      if (error instanceof WizardCancelledError) {
        return { kind: "cancelled" };
      }
      throw error;
    }
  }

  const state = inProjectSetupState(appRoot, { kind: "unresolved" });
  const boxes: AnySetupBox<SetupState>[] = [
    resolveProvisioning({
      asker: withAnswers({ deploy: "vercel" })(interactiveAsker(prompter)),
      prompter,
      targetDirectory: appRoot,
      mode: { headless: false },
      // The gate above already showed the current link; adopting it here would
      // skip the pickers that choosing "Link to another project" exists to reach.
      adoptExistingLink: false,
      // `eve link` links an existing project (the default); the `/model`
      // "Connect via a project" branch passes "create-or-link" so a fresh
      // agent can create its first project here instead of dead-ending on an
      // empty project list.
      projectSelection,
      deps: deps.resolveProvisioning,
    }),
    linkVercelProject({ prompter, deps: deps.linkProject }),
    // The default `inherit` gateway plan makes the credential box pull the
    // freshly linked project's env into .env.local.
    detectAiGateway(),
    applyAiGatewayCredential({ prompter, deps: deps.applyAiGatewayCredential }),
  ];

  const result = await runInteractive(boxes, state, prompterSink(prompter), {
    snapshot: snapshotSetupState,
    signal,
  });
  if (result.kind === "cancelled") {
    return { kind: "cancelled" };
  }

  const [oidcFile, gatewayKeyFile] = await Promise.all([
    deps.findEnvFileWithKey(appRoot, "VERCEL_OIDC_TOKEN"),
    deps.findEnvFileWithKey(appRoot, AI_GATEWAY_API_KEY_ENV_VAR),
  ]);
  signal?.throwIfAborted();
  // Success stays silent here: the caller owns the closing line (`eve link`'s
  // outro, the /model menu's "Connected to AI Gateway" notice), so only the
  // actionable failure earns output.
  if (oidcFile === undefined && gatewayKeyFile === undefined) {
    prompter.log.warning(
      "Linked, but no model credential landed in an env file (VERCEL_OIDC_TOKEN or " +
        "AI_GATEWAY_API_KEY). Run `vercel env pull` once the project has AI Gateway access.",
    );
  }
  const done: LinkFlowResult = { kind: "done" };
  if (oidcFile !== undefined) done.credential = "VERCEL_OIDC_TOKEN";
  else if (gatewayKeyFile !== undefined) done.credential = AI_GATEWAY_API_KEY_ENV_VAR;
  return done;
}
