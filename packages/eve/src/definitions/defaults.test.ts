import { describe, expect, it } from "vitest";

import { eve, sandboxDefinition } from "#definitions/defaults.js";
import { frameworkAgentSourceRegistry } from "#framework/sources/registry.js";
import { codeSandboxWith } from "#runtime/sandbox/code-sandbox-registry.js";
import { createSessionAgent, sandboxDefinitionOf } from "#runtime/sessions/code-agent.js";
import { MemorySandbox } from "#sandbox/providers/memory.js";
import { createMemorySandboxFileStore } from "#execution/sandbox/memory-files.js";

const sandbox = (revision: string) =>
  codeSandboxWith(MemorySandbox.environment({ files: createMemorySandboxFileStore() }), {
    appRoot: "/",
    preparedArtifact: async () => null,
    revision,
  });

describe("eve.defaults()", () => {
  it("lists the sandbox, then each default tool under the id its file takes", () => {
    expect(eve.defaults({ sandbox: sandbox("a") }).map(({ id }) => id)).toEqual([
      "sandbox",
      "tool::bash",
      "tool::read_file",
      "tool::write_file",
      "tool::edit_file",
      "tool::web_fetch",
      "tool::web_search",
      "tool::agent",
    ]);
  });

  it("leaves out the tools it's told to, and the sandbox when no kept tool runs in it", () => {
    expect(
      eve.defaults({ sandbox: sandbox("a"), without: ["web_fetch"] }).map(({ id }) => id),
    ).not.toContain("tool::web_fetch");
    expect(
      eve
        .defaults({
          sandbox: sandbox("a"),
          without: ["bash", "read_file", "write_file", "edit_file"],
        })
        .map(({ id }) => id),
    ).toEqual(["tool::web_fetch", "tool::web_search", "tool::agent"]);
    expect(
      eve.defaults({ sandbox: sandbox("a"), without: ["agent"] }).map(({ id }) => id),
    ).not.toContain("tool::agent");
  });

  it("is the list the compiler adds to every file agent's node, in its order", () => {
    const local = frameworkAgentSourceRegistry.registrations.find(
      ({ source }) => source.id === "eve:defaults",
    );
    expect(local?.source.modules.map(({ logicalPath }) => logicalPath)).toEqual([
      "agent.ts",
      "sandbox.ts",
      "tools/bash.ts",
      "tools/read_file.ts",
      "tools/write_file.ts",
      "tools/edit_file.ts",
      "tools/web_fetch.ts",
      "tools/web_search.ts",
    ]);
  });
});

describe("a code agent's sandbox", () => {
  it("is the first definition's that names one, and the agent owns it", async () => {
    const first = sandboxDefinition(sandbox("first"));
    const second = sandboxDefinition(sandbox("second"));
    expect(sandboxDefinitionOf([second, first])).toBe(second);
    const agent = createSessionAgent({ definitions: [first, second], id: "two-sandboxes" });
    const opened = await agent.sandbox();
    expect(opened?.registry.sandbox.definition.revisionHash).toBe("first");
    expect(opened?.sharesParent).toBe(false);
    expect(opened?.template).toEqual({
      appRoot: "/",
      preparedArtifact: expect.any(Function),
    });
  });
});
