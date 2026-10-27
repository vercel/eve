/**
 * Host facilities available to authored code running on an `eve dev` server.
 *
 * The capability is present when the executing host owns the authored root and
 * watcher control origin. It is unavailable in deployed runtimes and does not
 * vary by request or peer address, so it is not proof that the caller may
 * change the authored tree. Authorize the session's principal before editing
 * source on a caller's behalf.
 */
export { getLocalDevCapability, type LocalDevCapability } from "#runtime/local-dev-capability.js";
