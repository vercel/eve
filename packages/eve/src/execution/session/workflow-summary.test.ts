import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDurableSessionState } from "#execution/durable-session-store.js";
import {
  buildSessionWorkflowSummaryAttributes,
  writeSessionWorkflowSummary,
} from "#execution/session/workflow-summary.js";
import { setHarnessEmissionState } from "#harness/emission-state.js";
import { setTurnUsageState } from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";

const experimentalSetAttributes = vi.hoisted(() => vi.fn());
vi.mock("#internal/workflow/runtime.js", () => ({
  getWorld: vi.fn(async () => ({
    runs: { experimentalSetAttributes },
  })),
}));

function createSession(): HarnessSession {
  return {
    agent: {
      modelReference: { id: "anthropic/claude-sonnet-4.5" },
      system: "",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "test-token",
    history: [],
    sessionId: "session-test",
  };
}

describe("buildSessionWorkflowSummaryAttributes", () => {
  beforeEach(() => {
    experimentalSetAttributes.mockReset().mockResolvedValue(undefined);
  });

  it("uses completed-turn count and session totals instead of the latest turn totals", () => {
    const session = setHarnessEmissionState(
      setTurnUsageState(createSession(), {
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
        costUsd: 0.02,
        inputTokens: 50,
        model: "anthropic/claude-sonnet-4.5",
        outputTokens: 20,
        sawCost: true,
        session: {
          cacheReadTokens: 15,
          cacheWriteTokens: 6,
          costUsd: 0.07746884,
          inputTokens: 150,
          outputTokens: 60,
          sawCost: true,
        },
        turnId: "turn_1",
      }),
      { sequence: 2, sessionStarted: true, stepIndex: 0, turnId: "" },
    );

    expect(buildSessionWorkflowSummaryAttributes(createDurableSessionState({ session }))).toEqual({
      "$eve.model": "anthropic/claude-sonnet-4.5",
      "$eve.session_cache_read_tokens": 15,
      "$eve.session_cache_write_tokens": 6,
      "$eve.session_cost_usd": 0.07746884,
      "$eve.session_input_tokens": 150,
      "$eve.session_output_tokens": 60,
      "$eve.turn_count": 2,
    });
  });

  it("writes the summary to the anchored session run", async () => {
    const session = setHarnessEmissionState(createSession(), {
      sequence: 2,
      sessionStarted: true,
      stepIndex: 0,
      turnId: "",
    });
    const sessionState = createDurableSessionState({ session });

    await writeSessionWorkflowSummary({
      sessionId: "anchored-session-run",
      sessionState,
    });

    expect(experimentalSetAttributes).toHaveBeenCalledWith(
      "anchored-session-run",
      [{ key: "$eve.turn_count", value: "2" }],
      { allowReservedAttributes: true },
    );
  });
});
