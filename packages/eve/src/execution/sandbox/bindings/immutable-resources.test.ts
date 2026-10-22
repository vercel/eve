import { describe, expect, it, vi } from "vitest";

import { hydrateSandboxFromImmutableResources } from "#execution/sandbox/bindings/immutable-resources.js";

describe("hydrateSandboxFromImmutableResources", () => {
  it("copies materialized workspace and skills so the prepared image keeps them without the mount", async () => {
    const run = vi.fn(async (_input: { readonly command: string }) => ({
      exitCode: 0,
      stderr: "",
      stdout: "",
    }));
    await hydrateSandboxFromImmutableResources({ run } as never, "'/eve/resources'");
    const command = run.mock.calls[0]?.[0].command ?? "";
    expect(command).toContain("cp -a '/eve/resources'/workspace/. /workspace/");
    expect(command).toContain(`cp -a '/eve/resources'/skills/. "$HOME/.agents/skills/"`);
  });
});
