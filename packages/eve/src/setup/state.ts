import type { ChannelKind, ConnectionInput, ConnectionProtocol } from "#setup/scaffold/index.js";
import { isProjectResolved, type ProjectResolution } from "./project-resolution.js";

export { CURRENT_DIRECTORY_PROJECT_NAME } from "#setup/scaffold/index.js";

export type { ChannelKind };

export type ChatPreference = "web" | "slack" | "repl" | "api" | "skip";

export type AiGatewayEnvFile = ".env.local" | ".env";

export type ResolvedAiGatewayCredentials =
  | { kind: "unresolved" }
  | { kind: "api-key"; envFile: AiGatewayEnvFile };

export type ResolvedProjectPath =
  | { kind: "unresolved"; inPlace: boolean }
  | { kind: "resolved"; inPlace: boolean; path: string };

export interface ArgsHeadlessProject {
  skipVercel?: boolean;
  team?: string;
  project?: string;
}

export interface ArgsHeadlessAiGateway {
  apiKey?: string;
}

export type ProvisioningMode =
  | { headless: true; project: ArgsHeadlessProject; aiGateway: ArgsHeadlessAiGateway }
  | { headless: false };

export interface VercelProjectIdentity {
  projectId: string;
  projectName: string;
}

export type ResolvedVercelProject =
  | { kind: "none" }
  | { kind: "new"; project: string; team: string }
  | { kind: "existing"; project: VercelProjectIdentity; team: string };

export type ResolvedVercelProjectSpec = Extract<
  ResolvedVercelProject,
  { kind: "new" | "existing" }
>;

export type ResolvedAiGateway =
  | { kind: "inherit" }
  | { kind: "byok"; apiGatewayKey: string }
  | { kind: "byop" };

export type WiringMode = "gateway" | "self";

export type SetupMode = "complete" | "one-shot";

export interface ConnectionPlan {
  slug: string;
  protocol: ConnectionProtocol;
  entry: ConnectionInput;
  provision:
    | { kind: "connect"; service: string }
    | { kind: "connect-manual" }
    | { kind: "command-hint"; service: string }
    | { kind: "none" };
}

export interface SetupState {
  agentName: string;
  setupMode: SetupMode;
  modelId: string;
  modelWiring: WiringMode;
  connectionSelection: ConnectionPlan[];
  vercelProject: ResolvedVercelProject;
  aiGateway: ResolvedAiGateway;
  projectPath: ResolvedProjectPath;
  aiGatewayCredentials: ResolvedAiGatewayCredentials;
  chat: ChatPreference | null;

  deploymentDependenciesInstalled: boolean;
  project: ProjectResolution;
  deploymentPending: boolean;
}

export function createDefaultSetupState(): SetupState {
  return {
    deploymentDependenciesInstalled: false,
    project: { kind: "unresolved" },
    deploymentPending: false,
    agentName: "",
    setupMode: "complete",
    modelId: "",
    modelWiring: "gateway",
    connectionSelection: [],
    vercelProject: { kind: "none" },
    aiGateway: { kind: "inherit" },
    projectPath: { kind: "unresolved", inPlace: false },
    aiGatewayCredentials: { kind: "unresolved" },
    chat: null,
  };
}

export function hasVercelProject(state: Pick<SetupState, "vercelProject" | "project">): boolean {
  return state.vercelProject.kind !== "none" || isProjectResolved(state.project);
}

export function requireProjectPath(state: Pick<SetupState, "projectPath">): string {
  if (state.projectPath.kind === "resolved") {
    return state.projectPath.path;
  }
  throw new Error("Project path has not been resolved.");
}

export function snapshotSetupState(state: SetupState): SetupState {
  return Object.freeze({
    ...state,
    aiGatewayCredentials: Object.freeze({ ...state.aiGatewayCredentials }),
    aiGateway: Object.freeze({ ...state.aiGateway }),
    connectionSelection: Object.freeze([...state.connectionSelection]) as ConnectionPlan[],
    project: Object.freeze({ ...state.project }) as ProjectResolution,
    projectPath: Object.freeze({ ...state.projectPath }),
    vercelProject: Object.freeze({ ...state.vercelProject }),
  });
}
