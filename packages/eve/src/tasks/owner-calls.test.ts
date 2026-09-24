import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { createTaskRecord, taskTable } from "#internal/testing/task-records.js";
import { MAX_RETAINED_IDLE_AGENTS, retireIdleAgents } from "#tasks/owner-calls.js";
import { encodeTaskCreator } from "#tasks/results.js";

const NOW = "2026-09-24T14:02:00.000Z";

function principal(principalId: string): SessionAuthContext {
  return { attributes: {}, authenticator: "test", principalId, principalType: "user" };
}

describe("retireIdleAgents", () => {
  const idle = (index: number, starter: SessionAuthContext | null = null) =>
    createTaskRecord({
      callId: `call-${String(index)}`,
      child: {
        continuationToken: `t${String(index)}`,
        kind: "local",
        sessionId: `s${String(index)}`,
      },
      creator: encodeTaskCreator({ auth: starter }),
      delivered: true,
      id: `research-${String(index).padStart(6, "0")}`,
      startedAt: new Date(Date.parse(NOW) + index * 1000).toISOString(),
      status: "completed",
    });

  it("keeps the most recently started idle agents and retires the rest, oldest first", () => {
    const agents = Array.from({ length: MAX_RETAINED_IDLE_AGENTS + 2 }, (_, index) => idle(index));
    const working = createTaskRecord({ id: "research-working", startedAt: NOW });

    const { retired, table } = retireIdleAgents(taskTable([...agents, working]), null);

    expect(retired.map((record) => record.id)).toEqual([agents[0]!.id, agents[1]!.id]);
    expect(table.records).toHaveLength(MAX_RETAINED_IDLE_AGENTS + 1);
    expect(table.records).toContainEqual(working);
  });

  it("retires the calling principal's own idle agents before anyone else's", () => {
    const alice = principal("alice");
    const bob = principal("bob");
    // Bob's agents are the oldest, but Alice's new agent retires one of her own.
    const agents = Array.from({ length: MAX_RETAINED_IDLE_AGENTS + 1 }, (_, index) =>
      idle(index, index < 10 ? bob : alice),
    );

    const { retired } = retireIdleAgents(taskTable(agents), alice);

    expect(retired.map((record) => record.id)).toEqual([agents[10]!.id]);
  });

  it("retires another principal's agents once the caller has none idle", () => {
    const alice = principal("alice");
    const agents = Array.from({ length: MAX_RETAINED_IDLE_AGENTS + 1 }, (_, index) =>
      idle(index, principal("bob")),
    );

    const { retired } = retireIdleAgents(taskTable(agents), alice);

    expect(retired.map((record) => record.id)).toEqual([agents[0]!.id]);
  });

  it("leaves a table within the limit untouched", () => {
    const table = taskTable([idle(0), idle(1)]);
    expect(retireIdleAgents(table, null)).toEqual({ retired: [], table });
  });
});
