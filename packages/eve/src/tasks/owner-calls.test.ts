import { describe, expect, it } from "vitest";

import { createTaskRecord, taskTable } from "#internal/testing/task-records.js";
import { MAX_RETAINED_IDLE_AGENTS, retireIdleAgents } from "#tasks/owner-calls.js";

const NOW = "2026-09-24T14:02:00.000Z";

describe("retireIdleAgents", () => {
  const idle = (index: number) =>
    createTaskRecord({
      callId: `call-${String(index)}`,
      child: {
        continuationToken: `t${String(index)}`,
        kind: "local",
        sessionId: `s${String(index)}`,
      },
      delivered: true,
      id: `research-${String(index).padStart(6, "0")}`,
      startedAt: new Date(Date.parse(NOW) + index * 1000).toISOString(),
      status: "completed",
    });

  it("keeps the most recently started idle agents and retires the rest", () => {
    const agents = Array.from({ length: MAX_RETAINED_IDLE_AGENTS + 2 }, (_, index) => idle(index));
    const working = createTaskRecord({ id: "research-working", startedAt: NOW });

    const { retired, table } = retireIdleAgents(taskTable([...agents, working]));

    expect(retired.map((record) => record.id)).toEqual([agents[1]!.id, agents[0]!.id]);
    expect(table.records).toHaveLength(MAX_RETAINED_IDLE_AGENTS + 1);
    expect(table.records).toContainEqual(working);
  });

  it("leaves a table within the limit untouched", () => {
    const table = taskTable([idle(0), idle(1)]);
    expect(retireIdleAgents(table)).toEqual({ retired: [], table });
  });
});
