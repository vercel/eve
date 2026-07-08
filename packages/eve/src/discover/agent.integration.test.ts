import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildMemoryAgentProject } from "#internal/testing/memory-agent-source.js";
import { discoverAgent } from "#discover/discover-agent.js";
import {
  DISCOVER_EXTENSION_EVE_INCOMPATIBLE,
  DISCOVER_EXTENSION_MOUNT_AMBIGUOUS,
  DISCOVER_EXTENSION_MOUNT_MISSING_DECLARATION,
  DISCOVER_EXTENSION_NESTED_MOUNT_UNSUPPORTED,
  DISCOVER_EXTENSION_OVERRIDE_OUTSIDE_MOUNT,
  DISCOVER_EXTENSION_SCHEDULE_UNSUPPORTED,
} from "#discover/extensions.js";
import {
  DISCOVER_DEPRECATED_SYSTEM_SLOT,
  DISCOVER_EXTENSION_NAME_INVALID,
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

  it("discovers extension mounts as flat module sources keyed by the mount namespace", async () => {
    const project = buildMemoryAgentProject({
      appFiles: {
        "node_modules/@acme/crm/package.json": JSON.stringify({
          name: "@acme/crm",
          eve: { extension: "ext" },
        }),
        "node_modules/@acme/crm/ext/tools/search.ts": "export default {};\n",
        "node_modules/@acme/gizmo/package.json": JSON.stringify({
          name: "@acme/gizmo",
          eve: { extension: "ext" },
        }),
        "node_modules/@acme/gizmo/ext/tools/search.ts": "export default {};\n",
      },
      agentFiles: {
        "extensions/crm.ts": 'export { default } from "@acme/crm";\n',
        "extensions/gizmo.ts": 'export { default } from "@acme/gizmo";\n',
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.manifest.extensions).toEqual([
      {
        sourceKind: "module",
        logicalPath: "extensions/crm.ts",
        sourceId: "extensions/crm.ts",
      },
      {
        sourceKind: "module",
        logicalPath: "extensions/gizmo.ts",
        sourceId: "extensions/gizmo.ts",
      },
    ]);
    expect(result.manifest.resolvedExtensions.map((mount) => mount.namespace)).toEqual([
      "crm",
      "gizmo",
    ]);
  });

  it("rejects extension mount filenames that violate the namespace charset", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "extensions/123-invalid.ts": "export default {};\n",
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      DISCOVER_EXTENSION_NAME_INVALID,
    );
    expect(result.manifest.extensions).toEqual([]);
  });

  it("resolves a mounted extension package to its discovered source tree", async () => {
    const project = buildMemoryAgentProject({
      appFiles: {
        "node_modules/@acme/crm/package.json": JSON.stringify({
          name: "@acme/crm",
          eve: { extension: "ext" },
        }),
        "node_modules/@acme/crm/ext/tools/search.ts":
          'throw new Error("extension modules should not execute during discovery");\n',
        "node_modules/@acme/crm/ext/instructions/policy.md": "Use the CRM before guessing.",
      },
      agentFiles: {
        "extensions/crm.ts": 'export { default } from "@acme/crm";\n',
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.manifest.resolvedExtensions).toHaveLength(1);
    const mount = result.manifest.resolvedExtensions[0]!;
    expect(mount.namespace).toBe("crm");
    expect(mount.specifier).toBe("@acme/crm");
    expect(mount.packageName).toBe("@acme/crm");
    expect(mount.manifest.tools).toEqual([
      { sourceKind: "module", logicalPath: "tools/search.ts", sourceId: "tools/search.ts" },
    ]);
    expect(mount.manifest.instructions.map((entry) => entry.logicalPath)).toEqual([
      "instructions/policy.md",
    ]);
    expect(mount.manifest.resolvedExtensions).toEqual([]);
  });

  it("rejects an extension package that declares agent config", async () => {
    const project = buildMemoryAgentProject({
      appFiles: {
        "node_modules/@acme/crm/package.json": JSON.stringify({
          name: "@acme/crm",
          eve: { extension: "ext" },
        }),
        "node_modules/@acme/crm/ext/agent.ts":
          'export default { model: "anthropic/claude-sonnet-5" };\n',
        "node_modules/@acme/crm/ext/tools/search.ts": "export default {};\n",
      },
      agentFiles: {
        "extensions/crm.ts": 'export { default } from "@acme/crm";\n',
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "discover/extension-agent-config-unsupported",
    );
  });

  it("reports an unresolved mount when the extension package is missing", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "extensions/crm.ts": 'export { default } from "@acme/missing";\n',
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "discover/extension-mount-unresolved",
    );
    expect(result.manifest.resolvedExtensions).toEqual([]);
  });

  it("resolves a directory-form extension mount and composes the extension's tools", async () => {
    const project = buildMemoryAgentProject({
      appFiles: {
        "node_modules/@acme/crm/package.json": JSON.stringify({
          name: "@acme/crm",
          eve: { extension: "ext" },
        }),
        "node_modules/@acme/crm/ext/tools/search.ts":
          'throw new Error("extension modules should not execute during discovery");\n',
      },
      agentFiles: {
        "extensions/crm/extension.ts": 'export { default } from "@acme/crm";\n',
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.manifest.extensions).toEqual([
      {
        sourceKind: "module",
        logicalPath: "extensions/crm/extension.ts",
        sourceId: "extensions/crm/extension.ts",
      },
    ]);
    expect(result.manifest.resolvedExtensions).toHaveLength(1);
    const mount = result.manifest.resolvedExtensions[0]!;
    expect(mount.namespace).toBe("crm");
    expect(mount.specifier).toBe("@acme/crm");
    expect(mount.manifest.tools).toEqual([
      { sourceKind: "module", logicalPath: "tools/search.ts", sourceId: "tools/search.ts" },
    ]);
    // A directory mount always carries an overrides manifest (the mount dir is
    // itself an agent-shaped source); with no override slots authored it is
    // empty and composes to nothing.
    expect(mount.overrides?.agentRoot).toBe(resolve(project.agentRoot, "extensions", "crm"));
    expect(mount.overrides?.tools).toEqual([]);
  });

  it("carries a directory-mount override slot that shadows the extension's contribution", async () => {
    const project = buildMemoryAgentProject({
      appFiles: {
        "node_modules/@acme/crm/package.json": JSON.stringify({
          name: "@acme/crm",
          eve: { extension: "ext" },
        }),
        "node_modules/@acme/crm/ext/tools/search.ts":
          'throw new Error("extension modules should not execute during discovery");\n',
      },
      agentFiles: {
        "extensions/crm/extension.ts": 'export { default } from "@acme/crm";\n',
        "extensions/crm/tools/search.ts":
          'throw new Error("override modules should not execute during discovery");\n',
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    const mount = result.manifest.resolvedExtensions[0]!;
    // The extension's own tree still carries its `search` tool from the package.
    expect(mount.manifest.tools).toEqual([
      { sourceKind: "module", logicalPath: "tools/search.ts", sourceId: "tools/search.ts" },
    ]);
    // The consumer's override slot is discovered as an agent-shaped source so
    // the compiler can compose it under `crm__search` with consumer priority.
    expect(mount.overrides?.tools).toEqual([
      { sourceKind: "module", logicalPath: "tools/search.ts", sourceId: "tools/search.ts" },
    ]);
    // The override manifest is rooted at the mount directory — that root is
    // what rebases the override's module to the consumer's file, not the
    // extension package.
    expect(mount.overrides?.agentRoot).toBe(resolve(project.agentRoot, "extensions", "crm"));
  });

  it("reports an ambiguous mount when a namespace is both a file and a directory", async () => {
    const project = buildMemoryAgentProject({
      appFiles: {
        "node_modules/@acme/crm/package.json": JSON.stringify({
          name: "@acme/crm",
          eve: { extension: "ext" },
        }),
        "node_modules/@acme/crm/ext/tools/search.ts": "export default {};\n",
      },
      agentFiles: {
        "extensions/crm.ts": 'export { default } from "@acme/crm";\n',
        "extensions/crm/extension.ts": 'export { default } from "@acme/crm";\n',
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      DISCOVER_EXTENSION_MOUNT_AMBIGUOUS,
    );
    // The ambiguous namespace is dropped from both forms rather than resolved.
    expect(result.manifest.resolvedExtensions).toEqual([]);
    expect(
      result.manifest.extensions.some((entry) => entry.logicalPath.startsWith("extensions/crm")),
    ).toBe(false);
  });

  it("reports a directory mount missing its extension declaration", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "extensions/crm/tools/search.ts": "export default {};\n",
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      DISCOVER_EXTENSION_MOUNT_MISSING_DECLARATION,
    );
    expect(result.manifest.resolvedExtensions).toEqual([]);
  });

  it("rejects an agent-root tool that overrides a mounted extension's namespace", async () => {
    const project = buildMemoryAgentProject({
      appFiles: {
        "node_modules/@acme/crm/package.json": JSON.stringify({
          name: "@acme/crm",
          eve: { extension: "ext" },
        }),
        "node_modules/@acme/crm/ext/tools/search.ts": "export default {};\n",
      },
      agentFiles: {
        "extensions/crm.ts": 'export { default } from "@acme/crm";\n',
        // A root tool using the mounted `crm__` prefix would shadow the
        // extension from outside its mount directory.
        "tools/crm__search.ts": "export default {};\n",
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    const collision = result.diagnostics.find(
      (diagnostic) => diagnostic.code === DISCOVER_EXTENSION_OVERRIDE_OUTSIDE_MOUNT,
    );
    expect(collision).toBeDefined();
    expect(collision?.message).toContain("extensions/crm/");
  });

  it("rejects a mounted extension whose eve peer range the app does not satisfy", async () => {
    const project = buildMemoryAgentProject({
      appFiles: {
        "node_modules/@acme/crm/package.json": JSON.stringify({
          name: "@acme/crm",
          eve: { extension: "ext" },
          peerDependencies: { eve: "^2" },
        }),
        "node_modules/@acme/crm/ext/extension.ts": "export default {};\n",
        "node_modules/@acme/crm/ext/tools/search.ts": "export default {};\n",
      },
      agentFiles: {
        "extensions/crm.ts": 'export { default } from "@acme/crm";\n',
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
      eveVersion: "1.4.0",
    });

    const incompatible = result.diagnostics.find(
      (diagnostic) => diagnostic.code === DISCOVER_EXTENSION_EVE_INCOMPATIBLE,
    );
    expect(incompatible).toBeDefined();
    expect(incompatible?.message).toContain("^2");
    expect(incompatible?.message).toContain("1.4.0");
    expect(result.manifest.resolvedExtensions).toEqual([]);
  });

  it("mounts an extension when the app's eve satisfies its peer range", async () => {
    const project = buildMemoryAgentProject({
      appFiles: {
        "node_modules/@acme/crm/package.json": JSON.stringify({
          name: "@acme/crm",
          eve: { extension: "ext" },
          peerDependencies: { eve: "^2" },
        }),
        "node_modules/@acme/crm/ext/extension.ts": "export default {};\n",
        "node_modules/@acme/crm/ext/tools/search.ts": "export default {};\n",
      },
      agentFiles: {
        "extensions/crm.ts": 'export { default } from "@acme/crm";\n',
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
      eveVersion: "2.3.0",
    });

    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === DISCOVER_EXTENSION_EVE_INCOMPATIBLE,
      ),
    ).toBe(false);
    expect(result.manifest.resolvedExtensions).toHaveLength(1);
  });

  it("rejects an extension that declares schedules", async () => {
    const project = buildMemoryAgentProject({
      appFiles: {
        "node_modules/@acme/crm/package.json": JSON.stringify({
          name: "@acme/crm",
          eve: { extension: "ext" },
        }),
        "node_modules/@acme/crm/ext/extension.ts": "export default {};\n",
        // Background scheduling is the consuming agent's to own, not an extension's.
        "node_modules/@acme/crm/ext/schedules/sweep.md": '---\ncron: "0 9 * * *"\n---\nSweep.',
      },
      agentFiles: {
        "extensions/crm.ts": 'export { default } from "@acme/crm";\n',
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      DISCOVER_EXTENSION_SCHEDULE_UNSUPPORTED,
    );
  });

  it("rejects an extension that mounts another extension", async () => {
    const project = buildMemoryAgentProject({
      appFiles: {
        "node_modules/@acme/crm/package.json": JSON.stringify({
          name: "@acme/crm",
          eve: { extension: "ext" },
        }),
        "node_modules/@acme/crm/ext/extension.ts": "export default {};\n",
        "node_modules/@acme/crm/ext/tools/search.ts": "export default {};\n",
        // The mounted extension itself tries to mount another extension — not
        // supported yet, so discovery must reject it rather than drop it.
        "node_modules/@acme/crm/ext/extensions/inner.ts":
          'export { default } from "@acme/inner";\n',
      },
      agentFiles: {
        "extensions/crm.ts": 'export { default } from "@acme/crm";\n',
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    const nested = result.diagnostics.find(
      (diagnostic) => diagnostic.code === DISCOVER_EXTENSION_NESTED_MOUNT_UNSUPPORTED,
    );
    expect(nested).toBeDefined();
    expect(nested?.message).toContain("extensions/inner");
  });

  it("allows an agent-root tool whose name does not use a mounted namespace prefix", async () => {
    const project = buildMemoryAgentProject({
      appFiles: {
        "node_modules/@acme/crm/package.json": JSON.stringify({
          name: "@acme/crm",
          eve: { extension: "ext" },
        }),
        "node_modules/@acme/crm/ext/tools/search.ts": "export default {};\n",
      },
      agentFiles: {
        "extensions/crm.ts": 'export { default } from "@acme/crm";\n',
        // Not a `crm__` prefix, so it is a normal consumer tool.
        "tools/crm_helper.ts": "export default {};\n",
        "instructions.md": "You are a precise assistant.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === DISCOVER_EXTENSION_OVERRIDE_OUTSIDE_MOUNT,
      ),
    ).toBe(false);
  });
});
