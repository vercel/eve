import type { ChannelKind, ConnectionInput, ConnectionProtocol } from "#setup/scaffold/index.js";
import { isProjectResolved, type ProjectResolution } from "./project-resolution.js";

// Re-exported from the scaffold's project module, the single owner of the "." sentinel.
export { CURRENT_DIRECTORY_PROJECT_NAME } from "#setup/scaffold/index.js";

export type { ChannelKind };

/** Where the user wants to chat with the agent after scaffolding finishes. */
export type ChatPreference = "web" | "slack" | "repl" | "api" | "skip";

export type AiGatewayEnvFile = ".env.local" | ".env";

export type ResolvedAiGatewayCredentials =
  | { kind: "unresolved" }
  | { kind: "api-key"; envFile: AiGatewayEnvFile };

/**
 * The scaffold directory. `inPlace` is the directory decision (scaffold into
 * the target directory itself vs a `./<agentName>` child). The target step
 * resolves the path before the scaffold step writes it.
 */
export type ResolvedProjectPath =
  | { kind: "unresolved"; inPlace: boolean }
  | { kind: "resolved"; inPlace: boolean; path: string };

/**
 * The `--headless` Vercel project flags. Read ONLY on the headless path (see
 * {@link ProvisioningMode}): an interactive run prompts for these decisions
 * instead, so the args never reach the prompt code.
 *
 * Provisioning a Vercel project is the default; `skipVercel` is the explicit
 * opt-out, and `team`/`project` parameterize it.
 */
export interface ArgsHeadlessProject {
  /** Do not create, link, deploy, or inherit credentials from a Vercel project. */
  skipVercel?: boolean;
  /** Vercel team slug (scope). Undefined = the current vercel scope. */
  team?: string;
  /** Existing project slug to link. Undefined = create a new project named after the agent. */
  project?: string;
}

/**
 * The `--headless` AI Gateway flags, read only on the headless path alongside
 * {@link ArgsHeadlessProject}.
 */
export interface ArgsHeadlessAiGateway {
  /** AI Gateway API key. Undefined = inherit the linked project's gateway (OIDC). */
  apiKey?: string;
}

/**
 * Provisioning mode for the resolve-provisioning and preflight boxes. The
 * headless args live ONLY on the `headless: true` variant, so the interactive
 * path cannot read them: the type makes it unrepresentable. An interactive run
 * resolves every provisioning decision by prompting.
 */
export type ProvisioningMode =
  | { headless: true; project: ArgsHeadlessProject; aiGateway: ArgsHeadlessAiGateway }
  | { headless: false };

/**
 * Resolved project decision, fully concrete. The variant determines whether
 * the flow creates a project, links an existing one, or avoids Vercel project
 * mutation entirely. Decided once, up front, by the resolve-provisioning box.
 */
export type ResolvedVercelProject =
  | { kind: "none" }
  | { kind: "new"; project: string; team: string }
  | { kind: "existing"; project: string; team: string };

/** A concrete project to ensure exists and link. */
export type ResolvedVercelProjectSpec = Extract<
  ResolvedVercelProject,
  { kind: "new" | "existing" }
>;

/**
 * Resolved gateway-credential decision, independent of the project plan.
 * `inherit` uses the linked project's OIDC gateway; `byok` writes an AI
 * Gateway key; `byop` leaves provider credentials outside the AI Gateway path.
 */
export type ResolvedAiGateway =
  | { kind: "inherit" }
  | { kind: "byok"; apiGatewayKey: string }
  | { kind: "byop" };

/**
 * How the scaffolded agent reaches a model. `"gateway"` routes through the
 * Vercel AI Gateway (OIDC, or a pasted gateway key). `"self"` scaffolds an
 * inline provider `byok` block reading `process.env`, derived from the model
 * picked earlier in the interview. Decided by the resolve-provisioning box.
 */
export type WiringMode = "gateway" | "self";

/**
 * How much of the onboarding flow runs. `"complete"` is the full interview and
 * provisioning sequence; `"one-shot"` scaffolds the base template with the
 * default model and skips everything after the scaffold (provisioning, model,
 * channels, linking, credentials, connections, deploy, chat). Decided by the
 * select-setup-mode box right after the target is resolved.
 */
export type SetupMode = "complete" | "one-shot";

/**
 * One fully-specified connection to scaffold. The select-connections box
 * resolves everything a prompt could decide (slug, protocol, the entry
 * definition, and how the connector gets provisioned) during the interview,
 * so the add-connections box runs effects without prompting.
 */
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

/**
 * The in-memory state threaded through every setup box. Greenfield onboarding
 * populates every field, while in-project setup starts from the detected
 * on-disk facts and leaves the onboarding-only plans at their defaults.
 */
export interface SetupState {
  agentName: string;
  /** Decided by the select-setup-mode box; gates every post-scaffold box. */
  setupMode: SetupMode;
  modelId: string;
  modelWiring: WiringMode;
  /** Channels chosen in the interview phase; scaffolded later by the channels box. */
  channelSelection: ChannelKind[];
  /** Connections planned in the interview phase; scaffolded later by the connections box. */
  connectionSelection: ConnectionPlan[];
  /** Decided once by the resolve-provisioning box; executed later by the link box. */
  vercelProject: ResolvedVercelProject;
  /** Decided once by the resolve-provisioning box; executed by the AI Gateway credential box. */
  aiGateway: ResolvedAiGateway;
  projectPath: ResolvedProjectPath;
  aiGatewayCredentials: ResolvedAiGatewayCredentials;
  chat: ChatPreference | null;

  // Status retained while channel setup retries installs, deployments, or
  // Connect calls. Advanced by the channel and deploy boxes.
  /** Channels scaffolded so far in this run. */
  channels: ChannelKind[];
  webScaffolded: boolean;
  slackScaffolded: boolean;
  deploymentDependenciesInstalled: boolean;
  /** The linked Vercel project facts, from the link box or the on-disk `.vercel` link. */
  project: ProjectResolution;
  deploymentPending: boolean;
  slackbotCreated: boolean;
  slackbotAttached: boolean;
  slackConnectorUid: string | undefined;
  /** Deep link that opens a DM compose with the bot ("chat with your agent"). */
  slackChatUrl: string | undefined;
  slackWorkspaceName: string | undefined;
}

export function createDefaultSetupState(): SetupState {
  return {
    channels: [],
    webScaffolded: false,
    slackScaffolded: false,
    deploymentDependenciesInstalled: false,
    project: { kind: "unresolved" },
    deploymentPending: false,
    slackbotCreated: false,
    slackbotAttached: false,
    slackConnectorUid: undefined,
    slackChatUrl: undefined,
    slackWorkspaceName: undefined,
    agentName: "",
    setupMode: "complete",
    modelId: "",
    modelWiring: "gateway",
    channelSelection: [],
    connectionSelection: [],
    vercelProject: { kind: "none" },
    aiGateway: { kind: "inherit" },
    projectPath: { kind: "unresolved", inPlace: false },
    aiGatewayCredentials: { kind: "unresolved" },
    chat: null,
  };
}

/**
 * Whether this run has a Vercel project available, planned or already linked.
 * During onboarding the resolve-provisioning box records the plan at the end
 * of the interview (after channels and connections), so the first disjunct
 * drives the post-scaffold deploy gating. During in-project setup there is no
 * plan, but the detected on-disk link resolves `state.project`, so the second
 * disjunct fires instead. In the create flow `state.project` stays unresolved
 * until the link box runs, so the second disjunct only fires when a real link
 * exists.
 */
export function hasVercelProject(state: Pick<SetupState, "vercelProject" | "project">): boolean {
  return state.vercelProject.kind !== "none" || isProjectResolved(state.project);
}

export function requireProjectPath(state: Pick<SetupState, "projectPath">): string {
  if (state.projectPath.kind === "resolved") {
    return state.projectPath.path;
  }
  throw new Error("Project path has not been resolved.");
}

/**
 * Deep-frozen copy of {@link SetupState} for a box's gather and perform faces.
 * The contract types those faces as `Readonly<SetupState>`; this freeze makes
 * the guarantee hold at runtime for the nested plan objects too, so the only
 * state transition is `apply` on the live state.
 */
export function snapshotSetupState(state: SetupState): SetupState {
  return Object.freeze({
    ...state,
    aiGatewayCredentials: Object.freeze({ ...state.aiGatewayCredentials }),
    aiGateway: Object.freeze({ ...state.aiGateway }),
    channelSelection: Object.freeze([...state.channelSelection]) as ChannelKind[],
    connectionSelection: Object.freeze([...state.connectionSelection]) as ConnectionPlan[],
    channels: Object.freeze([...state.channels]) as ChannelKind[],
    project: Object.freeze({ ...state.project }) as ProjectResolution,
    projectPath: Object.freeze({ ...state.projectPath }),
    vercelProject: Object.freeze({ ...state.vercelProject }),
  });
}
