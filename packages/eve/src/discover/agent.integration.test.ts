import { describe, expect, it } from "vitest";

import { buildMemoryAgentProject } from "#internal/testing/memory-agent-source.js";
import { discoverAgent } from "#discover/discover-agent.js";
import {
  DISCOVER_DEPRECATED_SYSTEM_SLOT,
  DISCOVER_HOOK_NAME_INVALID,
  DISCOVER_MODULE_SLOT_COLLISION,
  DISCOVER_REQUIRED_INSTRUCTIONS_MISSING,
  DISCOVER_SANDBOX_DIRECTORY_INVALID,
  DISCOVER_SLOT_COLLISION,
  DISCOVER_TOOL_NAME_INVALID,
  DISCOVER_UNSUPPORTED_DIRECTORY,
} from "#discover/grammar.js";
import { DISCOVER_LIB_DIRECTORY_INVALID, DISCOVER_LIB_ENTRY_UNSUPPORTED } from "#discover/lib.js";
import {
  DISCOVER_SCHEDULE_FILE_UNSUPPORTED,
  DISCOVER_SCHEDULES_DIRECTORY_INVALID,
} from "#discover/schedules.js";

/**
 * Disk-fixture cases covered by the original `test/discover-agent.integration.test.ts`
 * (the `weather-agent`, `sandbox-agent`, and `extension-agent` fixtures) have
 * been intentionally dropped from this file: they assert that discovery
 * produces the expected manifest when run against a real committed fixture
 * tree, which is a scenario-tier concern. The equivalent end-to-end
 * coverage lives under `test/scenarios/compile-agent.scenario.test.ts`.
 * Every authored-grammar rule exercised by those disk cases is covered
 * here against an in-memory {@link buildMemoryAgentProject} tree.
 */
describe("discoverAgent (memory)", () => {
  it("discovers single-file schedules in both module and markdown forms with recursive nesting", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "agent.mjs": 'throw new Error("agent modules should not execute during discovery");\n',
        "channels/slack.mjs":
          'throw new Error("channel modules should not execute during discovery");\n',
        "lib/weather/client.js":
          'throw new Error("lib modules should not execute during discovery");\n',
        "sandbox/sandbox.mjs":
          'throw new Error("sandbox modules should not execute during discovery");\n',
        "schedules/cleanup.js":
          'throw new Error("schedule modules should not execute during discovery");\n',
        "schedules/daily-digest.md": '---\ncron: "0 9 * * *"\n---\nSend a morning weather digest.',
        "schedules/billing/invoice-sweep.mjs":
          'throw new Error("schedule modules should not execute during discovery");\n',
        "schedules/billing/dunning/retry.md": '---\ncron: "*/15 * * * *"\n---\nRetry dunning.',
        "instructions.md": "You are a precise assistant.",
        "tools/get_weather.mjs":
          'throw new Error("tool modules should not execute during discovery");\n',
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.manifest.configModule).toEqual({
      sourceKind: "module",
      logicalPath: "agent.mjs",
      sourceId: "agent.mjs",
    });
    expect(result.manifest.instructions).toEqual([
      {
        definition: {
          markdown: "You are a precise assistant.",
        },
        sourceKind: "markdown",
        logicalPath: "instructions.md",
        sourceId: "instructions.md",
      },
    ]);
    expect(result.manifest.channels).toEqual([
      {
        sourceKind: "module",
        logicalPath: "channels/slack.mjs",
        sourceId: "channels/slack.mjs",
      },
    ]);
    expect(result.manifest.schedules).toEqual([
      {
        definition: {
          cron: "*/15 * * * *",
          markdown: "Retry dunning.",
        },
        sourceKind: "markdown",
        logicalPath: "schedules/billing/dunning/retry.md",
        sourceId: "schedules/billing/dunning/retry.md",
      },
      {
        sourceKind: "module",
        logicalPath: "schedules/billing/invoice-sweep.mjs",
        sourceId: "schedules/billing/invoice-sweep.mjs",
      },
      {
        sourceKind: "module",
        logicalPath: "schedules/cleanup.js",
        sourceId: "schedules/cleanup.js",
      },
      {
        definition: {
          cron: "0 9 * * *",
          markdown: "Send a morning weather digest.",
        },
        sourceKind: "markdown",
        logicalPath: "schedules/daily-digest.md",
        sourceId: "schedules/daily-digest.md",
      },
    ]);
    expect(result.manifest.lib).toEqual([
      {
        sourceKind: "module",
        logicalPath: "lib/weather/client.js",
        sourceId: "lib/weather/client.js",
      },
    ]);
    expect(result.manifest.sandbox).toEqual({
      sourceKind: "module",
      logicalPath: "sandbox/sandbox.mjs",
      sourceId: "sandbox/sandbox.mjs",
    });
    expect(result.manifest.tools).toEqual([
      {
        sourceKind: "module",
        logicalPath: "tools/get_weather.mjs",
        sourceId: "tools/get_weather.mjs",
      },
    ]);
  });

  it("falls back to the deprecated system.md slot with a deprecation warning", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "system.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      DISCOVER_DEPRECATED_SYSTEM_SLOT,
    ]);
    expect(result.diagnostics[0]?.severity).toBe("warning");
    expect(result.manifest.instructions).toEqual([
      {
        definition: {
          markdown: "You are a precise assistant.",
        },
        sourceKind: "markdown",
        logicalPath: "system.md",
        sourceId: "system.md",
      },
    ]);
  });

  it("falls back to the deprecated system.ts module slot with a deprecation warning", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "system.ts": 'export default { markdown: "From legacy system module." };\n',
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      DISCOVER_DEPRECATED_SYSTEM_SLOT,
    ]);
    expect(result.manifest.instructions).toEqual([
      {
        sourceKind: "module",
        logicalPath: "system.ts",
        sourceId: "system.ts",
      },
    ]);
  });

  it("prefers instructions.md over the deprecated system.md without emitting a warning", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "instructions.md": "Preferred instructions.",
        "system.md": "Legacy fallback that should be ignored.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.manifest.instructions).toEqual([
      {
        definition: {
          markdown: "Preferred instructions.",
        },
        sourceKind: "markdown",
        logicalPath: "instructions.md",
        sourceId: "instructions.md",
      },
    ]);
  });

  it("discovers the instructions slot case-insensitively", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "INSTRUCTIONS.MD": "Uppercase instructions.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.manifest.instructions).toEqual([
      {
        definition: {
          markdown: "Uppercase instructions.",
        },
        sourceKind: "markdown",
        logicalPath: "instructions.md",
        sourceId: "instructions.md",
      },
    ]);
  });

  it("reports the required-instructions-missing diagnostic when no slot is authored", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      DISCOVER_REQUIRED_INSTRUCTIONS_MISSING,
    ]);
    expect(result.manifest.instructions).toEqual([]);
  });

  it("emits a slot collision when both .ts and .md schedules share a name", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "schedules/cleanup.md": '---\ncron: "* * * * *"\n---\nfrom md',
        "schedules/cleanup.ts": "export default {};",
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      DISCOVER_SLOT_COLLISION,
    );
    expect(result.manifest.schedules).toEqual([]);
  });

  it("emits an unsupported-file diagnostic for non-module/non-markdown leaves under schedules/", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "schedules/notes.txt": "stray file",
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      DISCOVER_SCHEDULE_FILE_UNSUPPORTED,
    );
  });

  it("reports slot collisions and module-slot collisions together", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "agent.js": "export default {};\n",
        "agent.mjs": "export default {};\n",
        "instructions.md": "You are a precise assistant.",
        "instructions.ts": "export default {};\n",
        "tools/get-weather.js": "export default {};\n",
        "tools/get-weather.mjs": "export default {};\n",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      DISCOVER_SLOT_COLLISION,
      DISCOVER_MODULE_SLOT_COLLISION,
      DISCOVER_MODULE_SLOT_COLLISION,
    ]);
    expect(result.manifest.instructions).toEqual([]);
    expect(result.manifest.configModule).toBeUndefined();
    expect(result.manifest.tools).toEqual([]);
  });

  it("accepts an empty connections/ directory without diagnostics", async () => {
    const project = buildMemoryAgentProject({
      agentDirectories: ["connections"],
      agentFiles: {
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.manifest.connections).toEqual([]);
  });

  it("reports an invalid schedules root that is not a directory", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        schedules: "not-a-directory",
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      DISCOVER_SCHEDULES_DIRECTORY_INVALID,
    ]);
    expect(result.manifest.schedules).toEqual([]);
  });

  it("reports an invalid sandbox root that is not a directory", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        sandbox: "not-a-directory",
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      DISCOVER_SANDBOX_DIRECTORY_INVALID,
    );
    expect(result.manifest.sandbox).toBeNull();
  });

  it("reports an invalid lib root that is not a directory", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        lib: "not-a-directory",
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      DISCOVER_LIB_DIRECTORY_INVALID,
    ]);
    expect(result.manifest.lib).toEqual([]);
  });

  it("discovers module-only lib sources and reports unsupported lib entries", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "lib/notes.md": "unsupported",
        "lib/weather/client.ts": "export const client = {};\n",
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      DISCOVER_LIB_ENTRY_UNSUPPORTED,
    ]);
    expect(result.manifest.lib).toEqual([
      {
        sourceKind: "module",
        logicalPath: "lib/weather/client.ts",
        sourceId: "lib/weather/client.ts",
      },
    ]);
  });

  it("ignores authored context and workspace directories as unsupported roots", async () => {
    const project = buildMemoryAgentProject({
      agentDirectories: ["context", "workspace"],
      agentFiles: {
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      DISCOVER_UNSUPPORTED_DIRECTORY,
      DISCOVER_UNSUPPORTED_DIRECTORY,
    ]);
    expect(result.manifest.instructions).toEqual([
      {
        definition: {
          markdown: "You are a precise assistant.",
        },
        sourceKind: "markdown",
        logicalPath: "instructions.md",
        sourceId: "instructions.md",
      },
    ]);
  });

  it("rejects authored tool filenames that violate the tool-name charset", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "instructions.md": "You are a precise assistant.",
        "tools/123_invalid.ts":
          "export default { description: 'invalid tool', async execute() { return null; } };\n",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      DISCOVER_TOOL_NAME_INVALID,
    );
    expect(
      result.diagnostics.find((diagnostic) => diagnostic.code === DISCOVER_TOOL_NAME_INVALID)
        ?.message,
    ).toMatch(/"123_invalid"/);
    expect(result.manifest.tools).toEqual([]);
  });

  it("accepts authored tool filenames with kebab-case", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "instructions.md": "You are a precise assistant.",
        "tools/get-weather.ts":
          "export default { description: 'ok', async execute() { return null; } };\n",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.manifest.tools).toEqual([
      {
        sourceKind: "module",
        logicalPath: "tools/get-weather.ts",
        sourceId: "tools/get-weather.ts",
      },
    ]);
  });

  it("accepts authored tool filenames that satisfy the model tool-name charset", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "instructions.md": "You are a precise assistant.",
        "tools/lookup_customer.ts":
          "export default { description: 'ok', async execute() { return null; } };\n",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.manifest.tools).toEqual([
      {
        sourceKind: "module",
        logicalPath: "tools/lookup_customer.ts",
        sourceId: "tools/lookup_customer.ts",
      },
    ]);
  });

  it("discovers nested hook files with depth-first ordering", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "hooks/audit.ts": "export default {};\n",
        "hooks/auth/guard.ts": "export default {};\n",
        "hooks/auth/prepare.ts": "export default {};\n",
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.manifest.hooks.map((entry) => entry.logicalPath)).toEqual([
      "hooks/auth/guard.ts",
      "hooks/auth/prepare.ts",
      "hooks/audit.ts",
    ]);
  });

  it("rejects authored hook filenames that violate the hook-name charset", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "hooks/123_invalid.ts": "export default {};\n",
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      DISCOVER_HOOK_NAME_INVALID,
    );
    expect(result.manifest.hooks).toEqual([]);
  });
});
