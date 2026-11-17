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

export interface ApplyAiGatewayCredentialDeps {
  appendEnv: typeof appendEnv;
  runVercelEnvPull: typeof runVercelEnvPull;
  detectAiGatewayResolution: typeof detectAiGatewayResolution;
}

interface ApplyAiGatewayCredentialOptions {
  prompter: Prompter;
  deps?: ApplyAiGatewayCredentialDeps;
}

export function applyAiGatewayCredential(
  options: ApplyAiGatewayCredentialOptions,
): SetupBox<SetupState, null, ResolvedAiGatewayCredentials> {
  const deps = options.deps ?? { appendEnv, runVercelEnvPull, detectAiGatewayResolution };

  return {
    id: "apply-ai-gateway-credential",

    shouldRun(state) {
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
      const onOutput = createPromptCommandOutput(prompter.log);
      const pulled = await withSpinner(
        prompter,
        "Pulling Vercel environment variables into .env.local...",
        () => deps.runVercelEnvPull(projectRoot, onOutput, signal),
      );
      signal?.throwIfAborted();
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
