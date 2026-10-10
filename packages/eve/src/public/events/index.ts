/**
 * The session event contract: the catalog of facts and progress records a session stream
 * carries, the shared fold that turns them into tables, and the selectors and guards that hooks,
 * channels, and clients read them with. No runtime dependencies.
 *
 * @packageDocumentation
 */

export * from "#protocol/session-events/index.js";
export * from "#protocol/session-projection/index.js";
