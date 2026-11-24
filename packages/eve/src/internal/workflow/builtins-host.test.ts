import { builtInHosts } from "#runtime/app.js";
import { describe, expect, it } from "vitest";

import { installedProcessEngine } from "#execution/hosts.js";

describe("Workflow's step bundle", () => {
  it("installs Workflow as the realm's durable engine when it loads", async () => {
    expect(installedProcessEngine(builtInHosts())).toBeUndefined();
    await import("#internal/workflow/builtins.js");
    expect(installedProcessEngine(builtInHosts())?.name).toBe("workflow");
  });
});
