// Public setup primitives remain available for programmatic onboarding flows,
// even though eve currently exposes no setup wizard command.
export { type OutputSink, type SetupBox, WizardCancelledError } from "./step.js";
export { InteractionRequired } from "./ask.js";
export {
  type AiGatewayEnvFile,
  type ArgsHeadlessAiGateway,
  type ArgsHeadlessProject,
  type ChannelKind,
  type ChatPreference,
  createDefaultSetupState,
  requireProjectPath,
  type ResolvedAiGateway,
  type ResolvedAiGatewayCredentials,
  type ResolvedProjectPath,
  type ResolvedVercelProject,
  type ResolvedVercelProjectSpec,
  type SetupMode,
  type SetupState,
  snapshotSetupState,
  type WiringMode,
} from "./state.js";
export {
  type AnySetupBox,
  runHeadless,
  runInteractive,
  type RunnerOptions,
  type RunResult,
} from "./runner.js";
export {
  createPrompter,
  type MultiSelectOptions,
  type NoteTone,
  type Prompter,
  type PrompterValue,
  type SelectCommonOptions,
  type SelectOption,
  type SingleSelectOptions,
} from "./prompter.js";
export {
  createHeadlessPrompter,
  formatHeadlessEvent,
  type HeadlessEvent,
  type HeadlessLogSink,
  type HeadlessNextStep,
  HeadlessPromptError,
} from "./headless.js";
export { composeOnboardingBoxes, type OnboardingBoxesOptions } from "./onboarding.js";
export { createPromptCommandOutput, type PromptCommandLog } from "./cli/index.js";
export {
  getPackageManagerStrategy,
  runPackageManagerInstall,
  runPnpmInstall,
  runVercel,
  spawnPackageManager,
  spawnPnpm,
  type PackageManagerStrategy,
  type RunPackageManagerOptions,
  type RunPnpmOptions,
  type RunVercelOptions,
} from "./primitives/index.js";
export {
  detectDeployment,
  detectProjectResolution,
  projectProductionUrlFromResolution,
  type DeploymentInfo,
  type DeploymentState,
  type ProjectResolution,
} from "./project-resolution.js";
export { runVercelEnvPull } from "./run-vercel-link.js";
export { provisionSlackbot, reconcileSlackUid, type ProvisionSlackbotResult } from "./slackbot.js";
export {
  setupConnectionConnector,
  type SetupConnectionConnectorOptions,
  type SetupConnectionConnectorResult,
} from "./connection-connector.js";
export {
  linkProject,
  requireAuth,
  resolveProjectByNameOrId,
  resolveTeam,
} from "./vercel-project.js";
