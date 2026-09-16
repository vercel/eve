import { describe, expect, it } from "vitest";

import { planSelfModificationRegistryInstall } from "./registry-install-plan.js";
import type { CatalogEntry } from "./tools/search_registry.js";

const lazyEntry: CatalogEntry = {
  address: "connection/linear",
  authoredTarget: "agent/connections/linear.ts",
  selfModification: { lazyConnect: true },
  declaresSetup: true,
  title: "Linear",
};

describe("self-modification registry install planning", () => {
  it("plans a stable random connector transform without resolving a project", () => {
    const plan = planSelfModificationRegistryInstall({
      createConnectorUid: (name) => `${name}-generated-id`,
      entry: lazyEntry,
      setupHandling: "requires-user-setup",
    });

    expect(plan.kind).toBe("install-with-transform");
    if (plan.kind !== "install-with-transform") throw new Error("Expected a source transform.");
    expect(plan.transform.target).toBe("agent/connections/linear.ts");
    expect(plan.transform.apply('  auth: connect("linear"),')).toContain(
      'connect("linear-generated-id")',
    );
  });

  it("allows deployed proposal workspaces to execute ordinary setup", () => {
    expect(
      planSelfModificationRegistryInstall({
        entry: { ...lazyEntry, selfModification: undefined },
        setupHandling: "execute",
      }).kind,
    ).toBe("install");
  });

  it("does not interpret lazy Connect policy without the explicit opt-in", () => {
    expect(
      planSelfModificationRegistryInstall({
        entry: { ...lazyEntry, selfModification: undefined },
        setupHandling: "requires-user-setup",
      }).kind,
    ).toBe("requires-user-setup");
  });

  it("fails closed to ordinary setup for incompatible metadata", () => {
    expect(
      planSelfModificationRegistryInstall({
        entry: { ...lazyEntry, authoredTarget: "agent/tools/linear.ts" },
        setupHandling: "requires-user-setup",
      }).kind,
    ).toBe("requires-user-setup");
  });
});
