/**
 * Runtime capabilities available only while a *local* `eve dev` process owns
 * this runtime.
 *
 * Everything exported here exists only in that setting: not in a deployed
 * runtime, and not in a TUI attached to a remote `eve dev <url>`, since no
 * local server was started for it either. {@link getLocalDevCapability}
 * returns `undefined` in both cases, which is the signal a tool should refuse
 * on rather than degrade.
 */
export { getLocalDevCapability, type LocalDevCapability } from "#runtime/local-dev-capability.js";
