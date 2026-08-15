import { describe, expect, it } from "vitest";

import type { InputRequest } from "#runtime/input/types.js";
import { resolvePendingInput } from "#harness/input-requests.js";
import { appendPendingInputBatch, getPendingInputBatches } from "#harness/pending-input-batches.js";
import type { HarnessSession } from "#harness/types.js";

const DUPLICATE_ID_ERROR =
  'Internal pending input invariant violated: requestId must be unique across all pending batches: "duplicate".';

function session(state?: HarnessSession["state"]): HarnessSession {
  return {
    agent: { modelReference: {} as never, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 0.8 },
    continuationToken: "test",
    history: [],
    sessionId: "session-1",
    state,
  };
}

function approval(requestId: string, callId: string): InputRequest {
  return {
    action: { callId, input: {}, kind: "tool-call", toolName: "bash" },
    kind: "tool-approval",
    prompt: "Approve bash",
    requestId,
  };
}

function question(requestId: string, callId: string): InputRequest {
  return {
    action: { callId, input: {}, kind: "tool-call", toolName: "ask_question" },
    display: "text",
    kind: "question",
    prompt: "Which option?",
    requestId,
  };
}

describe("pending input request ID uniqueness", () => {
  it("rejects duplicate IDs within a newly appended batch", () => {
    expect(() =>
      appendPendingInputBatch({
        requests: [approval("duplicate", "call-1"), question("duplicate", "call-2")],
        responseMessages: [],
        session: session(),
      }),
    ).toThrow(DUPLICATE_ID_ERROR);
  });

  it("rejects an approval/question ID collision across newly appended batches", () => {
    const first = appendPendingInputBatch({
      requests: [approval("duplicate", "call-1")],
      responseMessages: [],
      session: session(),
    });

    expect(() =>
      appendPendingInputBatch({
        requests: [question("duplicate", "call-2")],
        responseMessages: [],
        session: first,
      }),
    ).toThrow(DUPLICATE_ID_ERROR);
  });

  it("rejects duplicate IDs in a persisted batch collection", () => {
    const persisted = session({
      "eve.runtime.pendingInputBatches": [
        { requests: [approval("duplicate", "call-1")], responseMessages: [] },
        { requests: [question("duplicate", "call-2")], responseMessages: [] },
      ],
    });

    expect(() =>
      resolvePendingInput({
        session: persisted,
        stepInput: { inputResponses: [{ optionId: "approve", requestId: "duplicate" }] },
      }),
    ).toThrow(DUPLICATE_ID_ERROR);
  });

  it("rejects duplicate IDs in a persisted legacy singleton", () => {
    const persisted = session({
      "eve.runtime.pendingInputBatch": {
        requests: [question("duplicate", "call-1"), question("duplicate", "call-2")],
        responseMessages: [],
      },
    });

    expect(() => getPendingInputBatches(persisted.state)).toThrow(DUPLICATE_ID_ERROR);
  });
});

describe("persisted pending input validation", () => {
  it("rejects an unknown request kind instead of routing it as a question", () => {
    const persisted = session({
      "eve.runtime.pendingInputBatches": [
        {
          requests: [
            {
              ...question("unknown-kind", "call-unknown"),
              kind: "future-input-kind",
            },
          ],
          responseMessages: [],
        },
      ],
    });

    expect(() => resolvePendingInput({ session: persisted })).toThrow(
      "Unhandled pending input request kind: future-input-kind",
    );
  });
});
