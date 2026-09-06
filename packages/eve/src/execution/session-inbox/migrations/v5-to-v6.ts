import type { Migration } from "#execution/session-inbox/migration.js";
import { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";

export const v5ToV6 = {
  from: 5,
  to: 6,
  up: (wire) => ({ ...wire, version: 6 }),
  down(wire) {
    if (wire.kind !== "cancel") return { ...wire, version: 5 };
    if (wire.tasks === true) {
      throw new SessionInboxWireError(
        "Cannot encode session-owned task cancellation for wire version 5.",
      );
    }
    const { tasks: _tasks, ...cancel } = wire;
    return { ...cancel, version: 5 };
  },
} satisfies Migration<5, 6>;
