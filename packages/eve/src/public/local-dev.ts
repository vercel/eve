/**
 * Runtime capabilities available to authored code handling a same-machine
 * request to `eve dev`.
 *
 * A deployed runtime and a client attached to a development server over the
 * network receive `undefined`. A local TUI attached to an existing headless
 * server receives the capability because authorization follows its requests.
 */
export { getLocalDevCapability, type LocalDevCapability } from "#runtime/local-dev-capability.js";
