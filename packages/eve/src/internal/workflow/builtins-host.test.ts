import { describe, expect, it } from "vitest";

import { installedDurableHost } from "#execution/hosts.js";

describe("Workflow's step bundle", () => {
  it("installs Workflow as the realm's durable host when it loads", async () => {
    expect(installedDurableHost()).toBeUndefined();
    await import("#internal/workflow/builtins.js");
    expect(installedDurableHost()?.name).toBe("workflow");
  });
});
