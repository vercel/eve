import type { Migration, Wire } from "#execution/session-inbox/migration.js";

type PayloadV4 = Extract<Wire<4>, { kind: "deliver" }>["payload"];
type PayloadV5 = Extract<Wire<5>, { kind: "deliver" }>["payload"];

export const v4ToV5 = {
  from: 4,
  to: 5,
  up: (wire) => ({ ...wire, version: 5 }),
  down(wire) {
    if (wire.kind !== "deliver") return { ...wire, version: 4 };
    return { ...wire, payload: down(wire.payload), payloads: wire.payloads.map(down), version: 4 };
  },
} satisfies Migration<4, 5>;

function withoutCost<T extends { costUsd?: number }>(usage: T): Omit<T, "costUsd"> {
  const { costUsd: _cost, ...tokens } = usage;
  return tokens;
}

function down(payload: PayloadV5): PayloadV4 {
  if (payload.task === undefined) return payload;
  return {
    ...payload,
    task: {
      ...payload.task,
      views: payload.task.views?.map((view) => ({
        ...view,
        usage: view.usage === undefined ? undefined : withoutCost(view.usage),
      })),
      agentRequests: payload.task.agentRequests?.map((entry) => {
        if (entry.request.kind !== "agent-settled") return entry;
        const result = entry.request.result;
        return {
          ...entry,
          request: {
            ...entry.request,
            result: {
              ...result,
              usage: result.usage === undefined ? undefined : withoutCost(result.usage),
              outcome: { ...result.outcome, usageDelta: withoutCost(result.outcome.usageDelta) },
            },
          },
        };
      }),
    },
  };
}
