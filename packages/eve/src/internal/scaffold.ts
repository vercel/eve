/** Internal Agent Builder integration; not a stable authoring API. */
export {
  scaffoldBaseProject,
  type EvePackageContract,
  type ScaffoldBaseProjectOptions,
} from "#setup/scaffold/create/project.js";
export {
  ensureChannel,
  SLACK_CHANNEL_DEFAULT_ROUTE,
  type ChannelMutationResult,
  type EnsureChannelOptions,
} from "#setup/scaffold/update/channels.js";
export {
  ensureConnection,
  type ConnectionMutationResult,
  type EnsureConnectionOptions,
} from "#setup/scaffold/update/connections.js";
export {
  CONNECTION_CATALOG,
  type ConnectionCatalogEntry,
} from "#setup/scaffold/connections/catalog.js";
