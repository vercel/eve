/**
 * Durable session snapshot migrations.
 *
 * ## Adding a new snapshot version
 *
 * When a shape change cannot be expressed as a purely additive field:
 *
 * 1. Bump `DURABLE_SESSION_VERSION` in `durable-session-store.ts`.
 * 2. Update {@link DurableSessionSnapshot}, {@link DurableSession},
 *    `projectToDurableSession`, and `hydrateDurableSession`.
 * 3. Add `snapshot-v{N}-to-v{N+1}.ts` exporting one
 *    {@link VersionMigration} (`from: N`, `to: N + 1`, pure
 *    function, stamps the new `version`).
 * 4. Append the migration to {@link snapshotMigrations}.
 * 5. Cover it in `snapshot.test.ts`.
 */
import type { DurableSessionSnapshot } from "#execution/durable-session-store.js";
import { DURABLE_SESSION_VERSION } from "#execution/durable-session-store.js";

import { runMigrationChain, type VersionMigration } from "./chain.js";

/**
 * Ordered list of registered snapshot migrations. Empty today since
 * only v1 exists; new migrations append to the tail.
 */
const snapshotMigrations: readonly VersionMigration[] = [];

/**
 * Migrates a {@link DurableSessionSnapshot} up to
 * {@link DURABLE_SESSION_VERSION}. Pure; safe to call inline.
 */
export function migrateDurableSessionSnapshot(value: unknown): DurableSessionSnapshot {
  return runMigrationChain<DurableSessionSnapshot>({
    label: "durable session snapshot",
    migrations: snapshotMigrations,
    targetVersion: DURABLE_SESSION_VERSION,
    value,
  });
}
