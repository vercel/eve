import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  applyMemoryRecallBatches,
  canonicalizeMemoryRecords,
  clearMemorySessionState,
  createMemoryLock,
  projectMemoryHistory,
  readMemoryLocks,
  shouldCanonicalizeMemory,
  validateMemoryRecallResult,
} from "#shared/memory-state.js";

const turn = Object.freeze({ id: "turn_1", input: [], sequence: 1 });

function lock(
  scope: string | readonly string[] = "user_1",
  visibility: "scope" | "session" = "scope",
) {
  return createMemoryLock({
    namespace: "app",
    scope,
    slot: "profile",
    turn,
    visibility,
  });
}

function recall(input: {
  readonly history?: readonly ModelMessage[];
  readonly operationId: string;
  readonly records: readonly { readonly content: string; readonly id?: string }[];
  readonly scope?: string | readonly string[];
  readonly state?: Readonly<Record<string, unknown>>;
  readonly visibility?: "scope" | "session";
}) {
  const memoryLock = lock(input.scope, input.visibility);
  return applyMemoryRecallBatches({
    batches: [
      {
        lock: memoryLock,
        messages: validateMemoryRecallResult({ messages: input.records }, "profile"),
        operationId: input.operationId,
      },
    ],
    history: input.history ?? [],
    state: input.state,
  });
}

describe("memory record state", () => {
  it("uses typed, collision-resistant namespace and scope encodings", () => {
    const scalar = lock("a\u0000b");
    const tuple = lock(["a", "b"]);
    const otherNamespace = createMemoryLock({
      namespace: "app\u0000user_1",
      scope: "user_1",
      slot: "profile",
      turn,
      visibility: "scope",
    });

    expect(scalar.namespaceKey).toMatch(/^memns1_[A-Za-z0-9_-]{43}$/u);
    expect(scalar.scopeKey).toMatch(/^memscope1_[A-Za-z0-9_-]{43}$/u);
    expect(scalar.scope.key).toMatch(/^memscope1_[A-Za-z0-9_-]{43}$/u);
    expect(scalar.scopeKey).not.toBe(tuple.scopeKey);
    expect(scalar.scope.key).not.toBe(otherNamespace.scope.key);
  });

  it("rejects invalid or oversized namespace, scope, and recall identifiers", () => {
    expect(() => lock([])).toThrow("must not be empty");
    expect(() => lock(" ")).toThrow("non-empty string");
    expect(() => lock("x".repeat(1_025))).toThrow("1024 UTF-8 bytes");
    expect(() => lock(Array.from({ length: 17 }, (_, index) => String(index)))).toThrow(
      "16 components",
    );
    expect(() =>
      createMemoryLock({
        namespace: "x".repeat(1_025),
        scope: "user_1",
        slot: "profile",
        turn,
        visibility: "scope",
      }),
    ).toThrow("Memory namespace exceeds 1024 UTF-8 bytes");
    expect(() =>
      validateMemoryRecallResult(
        { messages: [{ content: "value", id: "x".repeat(1_025) }] },
        "profile",
      ),
    ).toThrow("id exceeds 1024 UTF-8 bytes");
  });

  it("validates the exact recall shape before records enter history", () => {
    expect(() =>
      validateMemoryRecallResult(
        {
          messages: [
            { content: "value", id: "same" },
            { content: "other", id: "same" },
          ],
        },
        "profile",
      ),
    ).toThrow('duplicate id "same"');
    expect(() => validateMemoryRecallResult({ messages: [{ content: "   " }] }, "profile")).toThrow(
      "content must be non-blank",
    );
    expect(() =>
      validateMemoryRecallResult(
        { messages: [{ content: "value", extra: true } as never] },
        "profile",
      ),
    ).toThrow("unknown key(s): extra");
  });

  it("supersedes keyed records, preserves unkeyed appends, and makes identical values a no-op", () => {
    const first = recall({
      operationId: "op_1",
      records: [{ content: "old profile", id: "profile" }, { content: "first note" }],
    });
    const second = recall({
      history: first.history,
      operationId: "op_2",
      records: [{ content: "new profile", id: "profile" }, { content: "second note" }],
      state: first.state,
    });
    const identical = recall({
      history: second.history,
      operationId: "op_3",
      records: [{ content: "new profile", id: "profile" }],
      state: second.state,
    });

    expect(identical.history).toHaveLength(second.history.length);
    expect(
      projectMemoryHistory({ locks: readMemoryLocks(second.state), messages: second.history }),
    ).toEqual([
      { content: "first note", role: "user" },
      { content: "new profile", role: "user" },
      { content: "second note", role: "user" },
    ]);
  });

  it("fails closed when an operation is replayed with a different result", () => {
    const first = recall({ operationId: "stable", records: [{ content: "one", id: "key" }] });
    expect(() =>
      recall({
        history: first.history,
        operationId: "stable",
        records: [{ content: "two", id: "key" }],
        state: first.state,
      }),
    ).toThrow("replayed with a different result");
  });

  it("enforces scope visibility while session visibility survives a scope change", () => {
    const scoped = recall({ operationId: "scope", records: [{ content: "private" }] });
    expect(
      projectMemoryHistory({ locks: { profile: lock("user_2") }, messages: scoped.history }),
    ).toEqual([]);

    const sessionVisible = recall({
      operationId: "session",
      records: [{ content: "sticky" }],
      visibility: "session",
    });
    expect(
      projectMemoryHistory({
        locks: { profile: lock("user_2", "session") },
        messages: sessionVisible.history,
      }),
    ).toEqual([{ content: "sticky", role: "user" }]);
  });

  it("canonicalizes private records independently", () => {
    let result = recall({
      operationId: "canonical_1",
      records: [{ content: "old", id: "key" }],
    });
    result = recall({
      history: result.history,
      operationId: "canonical_2",
      records: [{ content: "new", id: "key" }, { content: "note" }],
      state: result.state,
    });
    const ordinary = { content: "ordinary", role: "assistant" as const };
    const canonical = canonicalizeMemoryRecords([...result.history, ordinary]);

    expect(canonical.memory).toHaveLength(2);
    expect(canonical.ordinary).toEqual([ordinary]);
  });

  it("uses independent raw-log triggers and clears all framework memory state", () => {
    let result = recall({ operationId: "raw_0", records: [{ content: "note" }] });
    for (let index = 1; index <= 512; index++) {
      result = recall({
        history: result.history,
        operationId: `raw_${index}`,
        records: [{ content: `note ${index}` }],
        state: result.state,
      });
    }

    expect(shouldCanonicalizeMemory(result.history)).toBe(true);
    expect(clearMemorySessionState({ ...result.state, retained: true })).toEqual({
      retained: true,
    });
  });
});
