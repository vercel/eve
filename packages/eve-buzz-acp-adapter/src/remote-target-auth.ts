import { runRemoteAuthFlow, WizardCancelledError, type Prompter } from "eve/setup";
import {
  readEveTargetInfo,
  VercelDeploymentProtectionError,
  type EveTargetInfo,
} from "./eve-target.js";
import type { InstallTarget } from "./install-flow.js";

type RemoteAuthResult =
  | { kind: "cancelled" }
  | { kind: "failed"; message: string }
  | {
      kind: "prepared";
      target: { deployment: { ownerId: string } };
      resolveToken(): Promise<string>;
    };

interface RemoteTargetAuthDependencies {
  readEveTargetInfo: typeof readEveTargetInfo;
  runRemoteAuthFlow(input: Parameters<typeof runRemoteAuthFlow>[0]): Promise<RemoteAuthResult>;
}

const defaultDependencies: RemoteTargetAuthDependencies = {
  readEveTargetInfo,
  runRemoteAuthFlow,
};

export async function readInstallTargetInfo(options: {
  cwd: string;
  eveBin: string;
  prompter?: Prompter;
  target: InstallTarget;
  dependencies?: Partial<RemoteTargetAuthDependencies>;
}): Promise<{ info: EveTargetInfo; vercelScope?: string }> {
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const targetOptions = eveTargetOptions(options.target, options.eveBin);
  try {
    return { info: await dependencies.readEveTargetInfo(targetOptions) };
  } catch (error) {
    if (!(error instanceof VercelDeploymentProtectionError) || options.target.kind !== "remote") {
      throw error;
    }
    if (!options.prompter) {
      throw new Error(
        "Vercel Deployment Protection requires authentication. Run the installer interactively or set VERCEL_AUTOMATION_BYPASS_SECRET.",
      );
    }

    options.prompter.log.info("Authenticating the protected Vercel deployment...");
    const authentication = await dependencies.runRemoteAuthFlow({
      configureTrustedSources: true,
      prompter: options.prompter,
      serverUrl: options.target.url,
      workspaceRoot: options.cwd,
    });
    if (authentication.kind === "cancelled") throw new WizardCancelledError();
    if (authentication.kind === "failed") throw new Error(authentication.message);

    const token = await authentication.resolveToken();
    const info = await dependencies.readEveTargetInfo({
      ...targetOptions,
      headers: {
        authorization: `Bearer ${token}`,
        "x-vercel-trusted-oidc-idp-token": token,
      },
    });
    return {
      info,
      vercelScope: authentication.target.deployment.ownerId,
    };
  }
}

function eveTargetOptions(
  target: InstallTarget,
  eveBin: string,
): Parameters<typeof readEveTargetInfo>[0] {
  if (target.kind === "remote") return { eveBin, target: target.url, cwd: process.cwd() };
  return { eveBin, cwd: target.directory };
}
