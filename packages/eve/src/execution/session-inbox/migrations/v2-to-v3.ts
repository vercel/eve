import type { Migration } from "#execution/session-inbox/migration.js";

export const v2ToV3 = {
  from: 2,
  to: 3,
  up: (wire) => ({ ...wire, version: 3 }),
  down(wire) {
    if (wire.kind !== "deliver") return { ...wire, version: 2 };
    return {
      ...wire,
      deliveryMetadata: wire.deliveryMetadata?.map(
        ({ acceptedDeploymentId: _deployment, ...metadata }) => metadata,
      ),
      version: 2,
    };
  },
} satisfies Migration<2, 3>;
