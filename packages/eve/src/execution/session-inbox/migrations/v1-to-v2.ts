import type { Migration } from "#execution/session-inbox/migration.js";

export const v1ToV2 = {
  from: 1,
  to: 2,
  up(wire) {
    return wire.kind === "deliver"
      ? { ...wire, payload: wire.payload ?? {}, version: 2 }
      : { ...wire, version: 2 };
  },
  down(wire) {
    if (wire.kind !== "deliver" || wire.caller === undefined) return { ...wire, version: 1 };
    const { activityObserver: _observer, ...caller } = wire.caller;
    return { ...wire, caller, version: 1 };
  },
} satisfies Migration<1, 2>;
