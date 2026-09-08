import { beforeEach, describe, expect, it, vi } from "vitest";

import { startSubagent } from "#execution/tools/subagent/start.js";
import { startLocalSubagent } from "#subagents/start-local.js";
import { startRemoteSubagent } from "#subagents/start-remote.js";
import {
  readActionTraceContext,
  readSessionTraceContext,
} from "#tracing/agent-trace-context-store.js";

vi.mock("#subagents/start-local.js", () => ({ startLocalSubagent: vi.fn() }));
vi.mock("#subagents/start-remote.js", () => ({ startRemoteSubagent: vi.fn() }));
vi.mock("#tracing/agent-trace-context-store.js", () => ({
  readActionTraceContext: vi.fn(),
  readSessionTraceContext: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(startLocalSubagent).mockResolvedValue({ kind: "error" } as never);
  vi.mocked(startRemoteSubagent).mockResolvedValue({ kind: "error" } as never);
});

describe.each(["local", "remote"] as const)("startSubagent (%s)", (kind) => {
  it.each(["caller", "action", "session", "direct"] as const)(
    "applies the live audience ceiling to the selected %s context",
    async (source) => {
      const caller = {
        decision: { action: "record", recordInputs: true, recordOutputs: true } as const,
        forwardedTracePolicy: {
          originAudience: "public",
          ceiling: { recordInputs: true, recordOutputs: true },
        } as const,
        spanId: "2".repeat(16),
        traceFlags: 1,
        traceId: "1".repeat(32),
      };
      const childAction = {
        ...caller,
        spanId: "4".repeat(16),
        traceFlags: 1,
        traceId: "3".repeat(32),
      };
      const session = { ...caller, spanId: "6".repeat(16), traceId: "5".repeat(32) };
      vi.mocked(readActionTraceContext).mockImplementation(
        (_serializedContext, _sessionId, _turnId, callId) =>
          callId === "workflow-call"
            ? source === "caller"
              ? caller
              : undefined
            : source === "session"
              ? undefined
              : childAction,
      );
      vi.mocked(readSessionTraceContext).mockReturnValue(session);
      const selected = source === "caller" ? caller : source === "session" ? session : childAction;

      await startSubagent({
        auth: null,
        batchEvent: { sequence: 1, turnId: "turn-1" },
        bundle: {} as never,
        callbackBaseUrl: "https://parent.example",
        capabilities: undefined,
        channelMetadata: { kind: "http", metadata: { audience: "private" } },
        currentSession: {} as never,
        fanoutSize: 1,
        instrumentationCallId: source === "direct" ? undefined : "workflow-call",
        initiatorAuth: null,
        parentContinuationToken: "parent-token",
        sandboxSessionId: "parent-session",
        serializedContext: {},
        session: { rootSessionId: "root-session", sessionId: "parent-session" } as never,
        target:
          kind === "local"
            ? {
                action: { callId: "child-action" } as never,
                kind,
                source: { type: "runtime" },
              }
            : { action: { callId: "child-action" } as never, kind },
      });

      expect(readActionTraceContext).toHaveBeenCalledWith(
        {},
        "parent-session",
        "turn-1",
        source === "direct" ? "child-action" : "workflow-call",
      );
      const start = kind === "local" ? startLocalSubagent : startRemoteSubagent;
      const other = kind === "local" ? startRemoteSubagent : startLocalSubagent;
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          parent: {
            conversationId: "root-session",
            continuationToken: "parent-token",
            lineage: {
              callId: "child-action",
              rootSessionId: "root-session",
              sessionId: "parent-session",
              turn: { id: "turn-1", sequence: 1 },
            },
            traceContext: {
              ...selected,
              decision: { action: "record", recordInputs: false, recordOutputs: false },
            },
          },
        }),
      );
      expect(selected.decision.recordInputs).toBe(true);
      expect(other).not.toHaveBeenCalled();
    },
  );
});
