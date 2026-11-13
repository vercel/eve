// How an `eve dev` worker proves to its parent that it belongs to the same development session.

/** The environment variable holding the secret the parent shares with its workers. */
export const DEVELOPMENT_WORKFLOW_SECRET_ENV = "EVE_DEV_WORKFLOW_TRANSPORT_SECRET";

/** The request header a worker sends that secret in. */
export const DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER = "x-eve-dev-workflow-transport";
