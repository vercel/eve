import { describe, expect, it } from "vitest";

import { installedDurableHost } from "#execution/hosts.js";

// A deployed agent's Workflow step bundle loads `builtins.ts`. Without the durable host it
// installs, a retried step would skip its repair and durable-only features would refuse users,
// so loading it must install Workflow's host.
describe("Workflow's step bundle", () => {
  it("installs Workflow as the realm's durable host when it loads", async () => {
    expect(installedDurableHost()).toBeUndefined();
    await import("#internal/workflow/builtins.js");
    expect(installedDurableHost()?.name).toBe("workflow");
  });
});
