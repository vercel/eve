import { interactiveAsker, withAnswers } from "../ask.js";
import { AI_GATEWAY_API_KEY_ENV_VAR } from "../ai-gateway-api-key.js";
import {
  hasEnvValue,
  resolveGatewayCredential,
  type GatewayCredentialResolution,
} from "#internal/resolve-model-endpoint-status.js";
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
import pc from "#compiled/picocolors/index.js";

import { inProjectSetupState, prompterSink } from "./in-project.js";

export interface LinkFlowDeps {
  detectProjectIdentity: typeof detectProjectIdentity;
  findEnvFileWithKey: typeof findEnvFileWithKey;
  env: Record<string, string | undefined>;
  resolveProvisioning?: ResolveProvisioningDeps;
  linkProject?: LinkProjectDeps;
  applyAiGatewayCredential?: ApplyAiGatewayCredentialDeps;
}

type LinkFlowResult =
  | {
      kind: "done";
      resolution?: GatewayCredentialResolution;
    }
  | { kind: "cancelled" };

export async function runLinkFlow(input: {
  appRoot: string;
  prompter: Prompter;
  signal?: AbortSignal;
  projectSelection?: "create-or-link" | "existing-only";
  teamSelectMessage?: (currentTeam: string) => string;
  deps?: Partial<LinkFlowDeps>;
}): Promise<LinkFlowResult> {
  const { appRoot, prompter, signal, projectSelection = "existing-only" } = input;
  const deps: LinkFlowDeps = {
    detectProjectIdentity,
    findEnvFileWithKey,
    env: process.env,
    ...input.deps,
  };

  const identity = await withSpinner(prompter, "Checking the current Vercel link...", async () => {
    const detected = await deps.detectProjectIdentity(appRoot, { signal });
    signal?.throwIfAborted();
    return detected;
  });
  if (identity === undefined) {
    const [gatewayKey, oidc] = await Promise.all([
      deps.findEnvFileWithKey(appRoot, AI_GATEWAY_API_KEY_ENV_VAR),
      deps.findEnvFileWithKey(appRoot, "VERCEL_OIDC_TOKEN"),
    ]);
    const credentialFile = gatewayKey ?? oidc;
    if (credentialFile !== undefined && input.teamSelectMessage === undefined) {
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
      adoptExistingLink: false,
      projectSelection,
      teamSelectMessage: input.teamSelectMessage,
      deps: deps.resolveProvisioning,
    }),
    linkVercelProject({ prompter, deps: deps.linkProject }),
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
  if (oidcFile === undefined && gatewayKeyFile === undefined) {
    prompter.log.warning(
      "Linked, but no model credential landed in an env file (VERCEL_OIDC_TOKEN or " +
        "AI_GATEWAY_API_KEY). Run `vercel env pull` once the project has AI Gateway access.",
    );
  }
  const done: LinkFlowResult = { kind: "done" };
  const evidence: {
    apiKeyInEnv: boolean;
    apiKeyFile?: string;
    oidcFile?: string;
  } = { apiKeyInEnv: hasEnvValue(deps.env[AI_GATEWAY_API_KEY_ENV_VAR]) };
  if (gatewayKeyFile !== undefined) evidence.apiKeyFile = gatewayKeyFile;
  if (oidcFile !== undefined) evidence.oidcFile = oidcFile;
  const resolution = resolveGatewayCredential(evidence);
  if (resolution !== undefined) done.resolution = resolution;
  return done;
}
