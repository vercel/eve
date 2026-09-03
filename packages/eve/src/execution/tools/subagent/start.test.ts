import { beforeEach, describe, expect, it, vi } from "vitest";

import { startSubagent } from "#execution/tools/subagent/start.js";
import { startLocalSubagent } from "#subagents/start-local.js";
import { startRemoteSubagent } from "#subagents/start-remote.js";

vi.mock("#subagents/start-local.js", () => ({ startLocalSubagent: vi.fn() }));
vi.mock("#subagents/start-remote.js", () => ({ startRemoteSubagent: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(startLocalSubagent).mockResolvedValue({ kind: "error" } as never);
  vi.mocked(startRemoteSubagent).mockResolvedValue({ kind: "error" } as never);
});

describe("startSubagent", () => {
  it.each(["local", "remote"] as const)(
    "passes one parent context to the %s child with the exact caller span",
    async (kind) => {
      const caller = {
        spanId: "2".repeat(16),
        traceFlags: 1,
        traceId: "1".repeat(32),
      };

      await startSubagent({
        auth: null,
        batchEvent: { sequence: 1, turnId: "turn-1" },
        bundle: {} as never,
        callbackBaseUrl: "https://parent.example",
        capabilities: undefined,
        channelMetadata: undefined,
        currentSession: {} as never,
        fanoutSize: 1,
        initiatorAuth: null,
        parentContinuationToken: "parent-token",
        sandboxSessionId: "parent-session",
        session: { rootSessionId: "root-session", sessionId: "parent-session" } as never,
        target:
          kind === "local"
            ? {
                action: { callId: "child-action" } as never,
                kind,
                source: { type: "runtime" },
              }
            : { action: { callId: "child-action" } as never, kind },
        traceDispatch: { originAudience: "private", parentTraceContext: caller },
      });

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
            traceContext: caller,
            originAudience: "private",
          },
        }),
      );
      expect(other).not.toHaveBeenCalled();
    },
  );
});
