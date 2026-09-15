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
import type { ModelMessage } from "ai";

import type { DurableSession, DurableSessionSnapshot } from "#execution/durable-session-store.js";
import {
  DURABLE_SESSION_VERSION,
  MODEL_MESSAGE_FORMAT_VERSION,
} from "#execution/durable-session-store.js";
import { isUserModelMessage, type HarnessModelMessage } from "#harness/messages.js";

import { runMigrationChain, type VersionMigration } from "./chain.js";

/**
 * Ordered list of registered snapshot migrations. Empty today since
 * only v1 exists; new migrations append to the tail.
 */
const snapshotMigrations: readonly VersionMigration[] = [];

// Model-message history is versioned independently so the outer snapshot can
// remain v1 while pinned older drivers forward additive fields unchanged.
type MigratableDurableSessionSnapshot = Omit<
  DurableSessionSnapshot,
  "modelMessageFormatVersion" | "session"
> & {
  readonly modelMessageFormatVersion?: unknown;
  readonly session: Omit<DurableSession, "history"> & {
    readonly history: readonly ModelMessage[];
  };
};

/**
 * Migrates a {@link DurableSessionSnapshot} up to
 * {@link DURABLE_SESSION_VERSION}. Pure; safe to call inline.
 */
export function migrateDurableSessionSnapshot(value: unknown): DurableSessionSnapshot {
  const snapshot = runMigrationChain<MigratableDurableSessionSnapshot>({
    label: "durable session snapshot",
    migrations: snapshotMigrations,
    targetVersion: DURABLE_SESSION_VERSION,
    value,
  });

  if ("modelMessageFormatVersion" in snapshot) {
    const version = snapshot.modelMessageFormatVersion;
    if (typeof version !== "number") {
      throw new Error(
        'durable session model-message format: value has no numeric "modelMessageFormatVersion" field.',
      );
    }
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(
        `durable session model-message format: version ${version} is not a positive integer.`,
      );
    }
    if (version > MODEL_MESSAGE_FORMAT_VERSION) {
      throw new Error(
        `durable session model-message format: encountered version ${version}, which is newer than the supported version ${MODEL_MESSAGE_FORMAT_VERSION}. ` +
          "This usually indicates the history was written by a newer eve deployment than the one reading it.",
      );
    }
    if (version < MODEL_MESSAGE_FORMAT_VERSION) {
      throw new Error(
        `durable session model-message format: no migration registered for version ${version} → ${version + 1}.`,
      );
    }
    return snapshot as DurableSessionSnapshot;
  }

  // Pre-0.54 history used user-role messages for both human and framework input.
  // Keep the outer snapshot at v1 so a pinned older driver can still forward it.
  return {
    ...snapshot,
    modelMessageFormatVersion: MODEL_MESSAGE_FORMAT_VERSION,
    session: {
      ...snapshot.session,
      history: migrateLegacyModelMessageHistory(snapshot.session.history),
    },
  };
}

function migrateLegacyModelMessageHistory(
  messages: readonly ModelMessage[],
): HarnessModelMessage[] {
  const migrated: HarnessModelMessage[] = [];
  for (const message of messages) {
    if (message.role !== "user") {
      migrated.push(message);
      continue;
    }
    if (!("kind" in message)) {
      migrated.push({ ...message, kind: "legacy.unknown" });
      continue;
    }
    if (!isUserModelMessage(message)) {
      throw new TypeError("Expected every user-role model message to have a kind.");
    }
    migrated.push(message);
  }
  return migrated;
}
