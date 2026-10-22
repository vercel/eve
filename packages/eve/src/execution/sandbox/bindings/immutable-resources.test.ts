import { describe, expect, it, vi } from "vitest";

import { hydrateSandboxProviderResources } from "#execution/sandbox/bindings/immutable-resources.js";

describe("hydrateSandboxProviderResources", () => {
  it("copies materialized workspace and skills so the prepared image keeps them without the mount", async () => {
    const run = vi.fn(async (_input: { readonly command: string }) => ({
      exitCode: 0,
      stderr: "",
      stdout: "",
    }));
    await hydrateSandboxProviderResources({
      resources: { source: { key: "resources", kind: "materialized", path: "/compiled" } },
      session: { run } as never,
    });
    const command = run.mock.calls[0]?.[0].command ?? "";
    expect(command).toContain("cp -a /eve/resources/workspace/. /workspace/");
    expect(command).toContain('cp -a /eve/resources/skills/. "$HOME/.agents/skills/"');
  });
});
