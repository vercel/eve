export {
  byokProviderEnvVar,
  CURRENT_DIRECTORY_PROJECT_NAME,
  isEveProject,
  scaffoldBaseProject,
  type EvePackageContract,
  type ScaffoldBaseProjectOptions,
} from "./create/project.js";

export {
  scaffoldExtensionProject,
  type ScaffoldExtensionProjectOptions,
} from "./create/extension.js";

export {
  DEFAULT_SLACK_CONNECTOR_SLUG,
  SLACK_CHANNEL_DEFAULT_ROUTE,
  deriveSlackConnectorSlug,
  ensureChannel,
  hasVercelHostFramework,
  isNextJsProject,
  listAuthoredChannels,
  normalizeSlackConnectorSlug,
  resolveVercelHostFrameworkPreset,
  type ChannelKind,
  type ChannelMutationResult,
  type EnsureChannelOptions,
  type SlackConnectorSlug,
  type WebPackageVersions,
} from "./update/channels.js";

export { SCAFFOLDABLE_CHANNELS, type ScaffoldableChannel } from "./channels-catalog.js";

export {
  ensureConnection,
  ensureConnectionDependencies,
  listAuthoredConnections,
  type ConnectionInput,
  type ConnectionMutationAction,
  type ConnectionMutationResult,
  type EnsureConnectionOptions,
  type EnsureConnectionDependenciesOptions,
} from "./update/connections.js";

export {
  catalogSlugs,
  CONNECTION_CATALOG,
  CUSTOM_CONNECTION_SLUG,
  effectiveProtocols,
  endpointForProtocol,
  getCatalogEntry,
  isValidConnectionSlug,
  SUPPORTED_PROTOCOLS,
  type ConnectionAuthSpec,
  type ConnectionCatalogEntry,
  type ConnectionProtocol,
  type CustomConnectionInput,
  type EnvHeader,
  type McpEndpoint,
  type OpenApiEndpoint,
} from "./connections/catalog.js";

export { WriteFileExistsError } from "./files.js";

export { HumanActionRequiredError, type HumanAction } from "../human-action.js";
