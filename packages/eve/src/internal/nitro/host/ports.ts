/**
 * The dev server's port policy, isolated from the Nitro host implementation.
 * `start-development-server.ts` derives its bind-retry walk from these values.
 */

/** The port `eve dev` binds when none is requested. */
export const DEFAULT_DEVELOPMENT_SERVER_PORT = 2000;

/** How many consecutive ports the dev server tries past the default before giving up. */
export const MAX_DEVELOPMENT_SERVER_PORT_ATTEMPTS = 10;
