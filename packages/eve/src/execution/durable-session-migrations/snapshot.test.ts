import { describe, expect, it } from "vitest";

import {
  DURABLE_SESSION_VERSION,
  type DurableSessionSnapshot,
} from "#execution/durable-session-store.js";
import { projectToDurableSession } from "#execution/session.js";
import type { HarnessSession } from "#harness/types.js";

import { migrateDurableSessionSnapshot } from "./snapshot.js";

/**
 * Pins the no-op path and failure modes for the snapshot migrator.
 * Generic chain behavior is covered in `chain.test.ts`.
 */
describe("migrateDurableSessionSnapshot", () => {
  it("returns a v1 snapshot unchanged", () => {
    const snapshot: DurableSessionSnapshot = {
      session: projectToDurableSession(buildSession()),
      version: DURABLE_SESSION_VERSION,
    };

    const migrated = migrateDurableSessionSnapshot(snapshot);

    expect(migrated).toEqual(snapshot);
    expect(migrated.version).toBe(DURABLE_SESSION_VERSION);
  });

  it("preserves unrecognized fields on the snapshot through the migrator", () => {
    // Forward-compat: a newer deployment may append optional fields
    // without bumping the version; the migrator passes them through.
    const snapshotWithFutureField = {
      futureField: { hint: "experimental" },
      session: projectToDurableSession(buildSession()),
      version: DURABLE_SESSION_VERSION,
    };

    const migrated = migrateDurableSessionSnapshot(snapshotWithFutureField);

    expect((migrated as { futureField?: unknown }).futureField).toEqual({
      hint: "experimental",
    });
  });

  it("throws clearly on a version newer than the supported one", () => {
    expect(() =>
      migrateDurableSessionSnapshot({
        session: {},
        version: 999,
      }),
    ).toThrow(/durable session snapshot: encountered version 999/);
  });

  it("throws when the snapshot has no numeric version field", () => {
    expect(() => migrateDurableSessionSnapshot({ session: {} })).toThrow(
      /durable session snapshot: value has no numeric "version" field/,
    );
  });

  it("throws when no migration is registered for an older version", () => {
    // Unreachable until `DURABLE_SESSION_VERSION` moves past 1.
    // Guards the "bumped version but forgot a migration" failure mode.
    if (DURABLE_SESSION_VERSION === 1) {
      return;
    }
    expect(() =>
      migrateDurableSessionSnapshot({
        session: {},
        version: 1,
      }),
    ).toThrow(/no migration registered for version 1 → 2/);
  });
});

function buildSession(): HarnessSession {
  return {
    agent: {
      modelReference: { id: "test-model", contextWindowTokens: 200_000 },
      system: "test system",
      tools: [],
    },
    compaction: {
      lastKnownInputTokens: 0,
      lastKnownPromptMessageCount: 0,
      recentWindowSize: 10,
      threshold: 180_000,
    },
    continuationToken: "http:test",
    history: [],
    sessionId: "wrun_test",
  };
}
