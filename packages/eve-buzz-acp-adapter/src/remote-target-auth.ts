import {
  inspectVerifiedRemoteAgent,
  type Prompter,
  type VerifiedRemoteAgentInspection,
} from "eve/setup";
import { parseEveTargetInfo, readEveTargetInfo, type EveTargetInfo } from "./eve-target.js";
import type { InstallTarget } from "./install-flow.js";

interface RemoteTargetAuthDependencies {
  inspectVerifiedRemoteAgent(input: {
    serverUrl: string;
    workspaceRoot: string;
    prompter?: Prompter;
  }): Promise<VerifiedRemoteAgentInspection>;
  readEveTargetInfo: typeof readEveTargetInfo;
}

const defaultDependencies: RemoteTargetAuthDependencies = {
  inspectVerifiedRemoteAgent,
  readEveTargetInfo,
};

export async function readInstallTargetInfo(options: {
  cwd: string;
  eveBin: string;
  prompter?: Prompter;
  target: InstallTarget;
  dependencies?: Partial<RemoteTargetAuthDependencies>;
}): Promise<{ info: EveTargetInfo; vercelScope?: string }> {
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  if (options.target.kind === "local") {
    return {
      info: await dependencies.readEveTargetInfo({
        cwd: options.target.directory,
        eveBin: options.eveBin,
      }),
    };
  }

  const inspectionOptions: Parameters<typeof dependencies.inspectVerifiedRemoteAgent>[0] = {
    serverUrl: options.target.url,
    workspaceRoot: options.cwd,
  };
  if (options.prompter !== undefined) inspectionOptions.prompter = options.prompter;
  const inspection = await dependencies.inspectVerifiedRemoteAgent(inspectionOptions);
  const result: { info: EveTargetInfo; vercelScope?: string } = {
    info: parseEveTargetInfo(inspection.info),
  };
  if (inspection.vercelScope !== undefined) result.vercelScope = inspection.vercelScope;
  return result;
}
