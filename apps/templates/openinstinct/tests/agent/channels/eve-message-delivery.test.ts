import type { ChannelEventContext } from "eve/channels";
import type { EveChannelConfig } from "eve/channels/eve";
import type { SessionView } from "eve/events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { viewOf } from "@tests/helpers/session-view";
import type {
  finalizeScheduledReport,
  releaseScheduledReport,
} from "@db/services/scheduled-agent-jobs";

const channelCapture = vi.hoisted(() => {
  const configs: EveChannelConfig[] = [];
  return { configs };
});
const delivery = vi.hoisted(() => ({
  finalize: vi.fn<typeof finalizeScheduledReport>(),
  release: vi.fn<typeof releaseScheduledReport>(),
}));

vi.mock(import("eve/channels/eve"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    eveChannel(config: EveChannelConfig) {
      channelCapture.configs.push(config);
      return original.eveChannel(config);
    },
  };
});
vi.mock("@db/services/scheduled-agent-jobs", () => ({
  finalizeScheduledReport: delivery.finalize,
  releaseScheduledReport: delivery.release,
}));

// Loads the production channel so the mocked factory captures its event configuration.
await import("@agent/channels/eve");

const events = channelCapture.configs[0]?.events;
const handleCallSettled = events?.["call.settled"];
const handleTurnSettled = events?.["turn.settled"];
if (!handleCallSettled || !handleTurnSettled) {
  throw new Error("The Eve channel must configure scheduled report delivery.");
}

describe("Eve scheduled report delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delivery.finalize.mockResolvedValue(true);
    delivery.release.mockResolvedValue(true);
  });

  it("finalizes a report when send_message completes", async () => {
    const view = viewOf([
      [
        {
          data: {
            cause: { deliveryId: "delivery-1" },
            follows: null,
            turnId: "turn-1",
          },
          type: "turn.started",
        },
      ],
      [
        {
          data: {
            callId: "call-send-message",
            capability: { kind: "tool", name: "send_message" },
            input: { text: "The price fell." },
            owner: { runId: "run-1" },
          },
          scope: { runId: "run-1", turnId: "turn-1" },
          type: "call.requested",
        },
      ],
    ]);
    await handleCallSettled(
      {
        data: {
          callId: "call-send-message",
          outcome: "completed",
          output: { kind: "message", text: "The price fell." },
        },
        scope: { runId: "run-1", turnId: "turn-1" },
        type: "call.settled",
      },
      scheduledReportContext(view)
    );

    expect(delivery.finalize).toHaveBeenCalledExactlyOnceWith(
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000004",
      "delivered"
    );
  });

  it("suppresses a report when the turn finishes without send_message", async () => {
    await handleTurnSettled(
      {
        data: { outcome: "completed", turnId: "turn-1" },
        scope: { turnId: "turn-1" },
        type: "turn.settled",
      },
      scheduledReportContext(viewOf([]))
    );

    expect(delivery.finalize).toHaveBeenCalledExactlyOnceWith(
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000004",
      "suppressed"
    );
  });
});

function scheduledReportContext(view: SessionView) {
  return {
    channel: {},
    async getSandbox() {
      throw new Error("Sandbox access is outside this focused test.");
    },
    session: {
      auth: {
        current: {
          attributes: {
            scheduleId: "00000000-0000-4000-8000-000000000001",
            scheduledReportLeaseToken: "00000000-0000-4000-8000-000000000004",
            scheduledReportSequence: "1",
            scheduledRunId: "00000000-0000-4000-8000-000000000002",
          },
          authenticator: "scheduled-result",
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
    position: { index: 0, line: 2 },
    view,
  } satisfies ChannelEventContext;
}
