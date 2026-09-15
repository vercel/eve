import { describe, expect, it } from "vitest";

import {
  DURABLE_SESSION_VERSION,
  MODEL_MESSAGE_FORMAT_VERSION,
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
  it("returns a current snapshot without inspecting its history", () => {
    let historyReads = 0;
    const session = projectToDurableSession(buildSession());
    Object.defineProperty(session, "history", {
      get() {
        historyReads += 1;
        return [];
      },
    });
    const snapshot: DurableSessionSnapshot = {
      modelMessageFormatVersion: MODEL_MESSAGE_FORMAT_VERSION,
      session,
      version: DURABLE_SESSION_VERSION,
    };

    const migrated = migrateDurableSessionSnapshot(snapshot);

    expect(migrated).toBe(snapshot);
    expect(migrated.version).toBe(DURABLE_SESSION_VERSION);
    expect(migrated.modelMessageFormatVersion).toBe(MODEL_MESSAGE_FORMAT_VERSION);
    expect(historyReads).toBe(0);
  });

  it("preserves unrecognized fields on the snapshot through the migrator", () => {
    // Forward-compat: a newer deployment may append optional fields
    // without bumping the version; the migrator passes them through.
    const snapshotWithFutureField = {
      futureField: { hint: "experimental" },
      modelMessageFormatVersion: MODEL_MESSAGE_FORMAT_VERSION,
      session: projectToDurableSession(buildSession()),
      version: DURABLE_SESSION_VERSION,
    };

    const migrated = migrateDurableSessionSnapshot(snapshotWithFutureField);

    expect((migrated as { futureField?: unknown }).futureField).toEqual({
      hint: "experimental",
    });
  });

  it("repairs unversioned model-message history and stamps its format", () => {
    const durable = projectToDurableSession(buildSession());
    let assistantRoleReads = 0;
    const assistantMessage = {
      content: "Already answered.",
      get role(): "assistant" {
        assistantRoleReads += 1;
        return "assistant";
      },
    };

    const migrated = migrateDurableSessionSnapshot({
      session: {
        ...durable,
        history: [assistantMessage, { content: "Retained before eve 0.54.", role: "user" }],
      },
      version: DURABLE_SESSION_VERSION,
    });

    expect(assistantRoleReads).toBe(1);
    expect(migrated.session.history[0]).toBe(assistantMessage);
    expect(migrated.session.history[1]).toEqual({
      content: "Retained before eve 0.54.",
      kind: "legacy.unknown",
      role: "user",
    });
    expect(migrated.modelMessageFormatVersion).toBe(MODEL_MESSAGE_FORMAT_VERSION);
  });

  it("rejects a model-message format written by a newer deployment", () => {
    const durable = projectToDurableSession(buildSession());

    expect(() =>
      migrateDurableSessionSnapshot({
        modelMessageFormatVersion: 2,
        session: durable,
        version: DURABLE_SESSION_VERSION,
      }),
    ).toThrow(/model-message format: encountered version 2/);
  });

  it("rejects malformed explicit model-message format versions", () => {
    const durable = projectToDurableSession(buildSession());

    expect(() =>
      migrateDurableSessionSnapshot({
        modelMessageFormatVersion: "1",
        session: durable,
        version: DURABLE_SESSION_VERSION,
      }),
    ).toThrow(/no numeric "modelMessageFormatVersion" field/);
  });

  it.each([0, 1.5])("rejects invalid model-message format version %s", (version) => {
    const durable = projectToDurableSession(buildSession());

    expect(() =>
      migrateDurableSessionSnapshot({
        modelMessageFormatVersion: version,
        session: durable,
        version: DURABLE_SESSION_VERSION,
      }),
    ).toThrow(/model-message format: version .* is not a positive integer/);
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
