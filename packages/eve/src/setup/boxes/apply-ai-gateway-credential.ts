import { createPromptCommandOutput } from "#setup/cli/index.js";

import {
  AI_GATEWAY_API_KEY_ENV_FILE,
  AI_GATEWAY_API_KEY_ENV_VAR,
  writeAiGatewayApiKey,
} from "../ai-gateway-api-key.js";
import { appendEnv } from "../append-env.js";
import { isProjectResolved } from "../project-resolution.js";
import type { Prompter } from "../prompter.js";
import { runVercelEnvPull } from "../run-vercel-link.js";
import { withSpinner } from "../with-spinner.js";
import {
  requireProjectPath,
  type ResolvedAiGatewayCredentials,
  type SetupState,
} from "../state.js";
import type { SetupBox } from "../step.js";
import { detectAiGatewayResolution } from "./detect-ai-gateway.js";

/** Injected for tests; defaults to the real env-file and Vercel helpers. */
export interface ApplyAiGatewayCredentialDeps {
  appendEnv: typeof appendEnv;
  runVercelEnvPull: typeof runVercelEnvPull;
  detectAiGatewayResolution: typeof detectAiGatewayResolution;
}

export interface ApplyAiGatewayCredentialOptions {
  /** Reports credential progress and warnings. The box never prompts through it. */
  prompter: Prompter;
  deps?: ApplyAiGatewayCredentialDeps;
}

/**
 * THE AI GATEWAY CREDENTIAL BOX. Executes the resolved {@link ResolvedAiGateway}
 * after the project link is settled. It carries nothing about the project
 * decision: whether a project is linked is read from `state.project` (set by
 * the link box), and the credential choice is read from `state.aiGateway`
 * (set by the resolve-provisioning box). The gather prompts for nothing;
 * `perform` owns all the work: `byok` writes a pasted AI Gateway key, `inherit` pulls the
 * linked project's OIDC gateway, and `byop` leaves provider credentials to the
 * scaffolded provider block.
 */
export function applyAiGatewayCredential(
  options: ApplyAiGatewayCredentialOptions,
): SetupBox<SetupState, null, ResolvedAiGatewayCredentials> {
  const deps = options.deps ?? { appendEnv, runVercelEnvPull, detectAiGatewayResolution };

  return {
    id: "apply-ai-gateway-credential",

    shouldRun(state) {
      // The resolved plan is authoritative, not a pre-link key detection.
      // `byok` always re-asserts the pasted key. `inherit` pulls env whenever a
      // project is linked, so a freshly-linked new project still inherits even
      // though the detect-ai-gateway box may have detected a stale key before
      // the link. With no linked project there is nothing to inherit, so any
      // detected key stays. `byop` is handled by the scaffolded provider
      // block, so this AI Gateway box has nothing to mutate.
      const { aiGateway, project } = state;
      return (
        aiGateway.kind === "byok" || (aiGateway.kind === "inherit" && isProjectResolved(project))
      );
    },

    async gather(): Promise<null> {
      return null;
    },

    async perform({ state, signal }): Promise<ResolvedAiGatewayCredentials> {
      const { prompter } = options;
      const projectRoot = requireProjectPath(state);
      const plan = state.aiGateway;
      const linked = isProjectResolved(state.project);
      if (plan.kind === "byop") {
        return { kind: "unresolved" };
      }
      if (plan.kind === "byok") {
        const location = await writeAiGatewayApiKey({
          projectRoot,
          apiKey: plan.apiGatewayKey,
          appendEnv: deps.appendEnv,
        });
        options.prompter.log.success(`Wrote ${location.envKey} to ${location.envPath}`);
        return { kind: "api-key", envFile: location.envFile };
      }
      if (!linked) {
        prompter.log.warning(
          "No Vercel project linked and no API key provided. The agent will not reach a model " +
            `until you set ${AI_GATEWAY_API_KEY_ENV_VAR} in ${AI_GATEWAY_API_KEY_ENV_FILE} or link a project.`,
        );
        return { kind: "unresolved" };
      }
      // Only claim success when the pull actually completed; a failed pull leaves
      // no inherited credential, so reporting "connected" would be a lie.
      const onOutput = createPromptCommandOutput(prompter.log);
      const pulled = await withSpinner(
        prompter,
        "Pulling Vercel environment variables into .env.local...",
        () => deps.runVercelEnvPull(projectRoot, onOutput, signal),
      );
      signal?.throwIfAborted();
      // Success stays silent — the caller's closing line reports it; only the
      // actionable failure earns output here.
      if (!pulled) {
        prompter.log.warning(
          "Linked the project, but pulling environment variables did not complete.",
        );
      }
      return deps.detectAiGatewayResolution(projectRoot);
    },

    apply(state, payload) {
      return { ...state, aiGatewayCredentials: payload };
    },
  };
}
