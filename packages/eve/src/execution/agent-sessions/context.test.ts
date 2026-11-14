import { describe, expect, it } from "vitest";
import {
  OccurrenceIdKey,
  ScheduleIdKey,
  ScheduleInstanceKey,
  ScheduleNamespaceKey,
} from "#context/keys.js";
import { captureAgentSessionContext } from "#execution/agent-sessions/context.js";

type Caller = Parameters<typeof captureAgentSessionContext>[0];

describe("captureAgentSessionContext", () => {
  it("passes the schedule's namespace to a subagent so currentSchedule() can address it", () => {
    const caller = {
      batch: { event: { sequence: 1, stepIndex: 0, turnId: "turn-1" } } as Caller["batch"],
      capabilities: undefined,
      channelMetadata: undefined,
      dynamicSubagentSelections: {},
      inheritedConversation: undefined,
      sandboxSessionId: "session-1",
      owner: { reference: { kind: "bundle", nodeId: "root", source: {} } } as Caller["owner"],
      serializedContext: {
        [ScheduleIdKey.name]: "reminders",
        [ScheduleInstanceKey.name]: "daily",
        [OccurrenceIdKey.name]: "exec-1",
        [ScheduleNamespaceKey.name]: "eve-reminders",
      },
      session: { sessionId: "session-1" } as Caller["session"],
      workflowAgents: {},
    } as Caller;

    expect(captureAgentSessionContext(caller, "call-1").schedule).toEqual({
      definition: "reminders",
      instance: "daily",
      namespace: "eve-reminders",
      occurrenceId: "exec-1",
    });
  });
});
