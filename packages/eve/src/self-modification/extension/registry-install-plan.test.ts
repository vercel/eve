import { describe, expect, it } from "vitest";

import { planSelfModificationRegistryInstall } from "./registry-install-plan.js";
import { parseRegistryIndex, type CatalogEntry } from "./tools/search_registry.js";

const lazyEntry: CatalogEntry = {
  address: "connection/linear",
  authoredTarget: "agent/connections/linear.ts",
  selfModification: { lazyConnect: true },
  setup: {
    commands: [
      {
        package: "eve",
        bin: "eve",
        args: ["integration", "connect", "linear", "mcp.linear.app", "linear"],
      },
    ],
  },
  title: "Linear",
};

describe("self-modification registry install planning", () => {
  it("plans a project-scoped source transform for opted-in Connect items", () => {
    const plan = planSelfModificationRegistryInstall({
      entry: lazyEntry,
      missingProject: "requires-user-setup",
      setupHandling: "requires-user-setup",
      projectId: "prj_abc123",
    });

    expect(plan.kind).toBe("install-with-transform");
    if (plan.kind !== "install-with-transform") throw new Error("Expected a source transform.");
    expect(plan.transform.target).toBe("agent/connections/linear.ts");
    expect(plan.transform.apply('const auth = connect("linear");')).toContain(
      'connect({ connector: "linear-prj_abc123", autoProvision: true })',
    );
  });

  it("preserves terminal setup without a local project and fails deployed setup closed", () => {
    expect(
      planSelfModificationRegistryInstall({
        entry: lazyEntry,
        missingProject: "requires-user-setup",
        setupHandling: "requires-user-setup",
      }).kind,
    ).toBe("requires-user-setup");
    expect(
      planSelfModificationRegistryInstall({
        entry: lazyEntry,
        missingProject: "cannot-install",
        setupHandling: "execute",
      }).kind,
    ).toBe("cannot-install");
  });

  it("allows deployed proposal workspaces to execute ordinary setup", () => {
    expect(
      planSelfModificationRegistryInstall({
        entry: { ...lazyEntry, selfModification: undefined },
        missingProject: "cannot-install",
        setupHandling: "execute",
      }).kind,
    ).toBe("install");
  });

  it("does not interpret lazy Connect policy without the explicit opt-in", () => {
    expect(
      planSelfModificationRegistryInstall({
        entry: { ...lazyEntry, selfModification: undefined },
        missingProject: "requires-user-setup",
        setupHandling: "requires-user-setup",
        projectId: "prj_abc123",
      }).kind,
    ).toBe("requires-user-setup");
  });

  it("fails closed to ordinary setup when an opted-in declaration is malformed", () => {
    const [entry] = parseRegistryIndex({
      items: [
        {
          name: "connection/linear",
          files: [{ target: "agent/connections/linear.ts" }],
          meta: {
            eve: {
              selfModification: { lazyConnect: true },
              setup: { package: "eve", bin: "eve", args: "invalid" },
            },
          },
        },
      ],
    });
    expect(entry).toBeDefined();
    expect(
      planSelfModificationRegistryInstall({
        entry: entry!,
        missingProject: "requires-user-setup",
        setupHandling: "requires-user-setup",
        projectId: "prj_abc123",
      }).kind,
    ).toBe("requires-user-setup");
  });

  it("fails closed to ordinary setup for incompatible metadata", () => {
    expect(
      planSelfModificationRegistryInstall({
        entry: { ...lazyEntry, authoredTarget: "agent/tools/linear.ts" },
        missingProject: "requires-user-setup",
        setupHandling: "requires-user-setup",
        projectId: "prj_abc123",
      }).kind,
    ).toBe("requires-user-setup");
  });
});
