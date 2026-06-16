import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildMemoryAgentProject } from "#internal/testing/memory-agent-source.js";
import { DISCOVER_SANDBOX_DIRECTORY_INVALID } from "#discover/grammar.js";
import { discoverAgent } from "#discover/discover-agent.js";
import {
  DISCOVER_LOCAL_SUBAGENT_SCHEDULES_INVALID,
  DISCOVER_REQUIRED_SUBAGENT_CONFIG_MODULE_MISSING,
  discoverSubagents,
} from "#discover/discover-subagent.js";

describe("discoverSubagents (memory)", () => {
  it("discovers recursive local subagent packages through the agent manifest", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "subagents/researcher/agent.mjs":
          'throw new Error("local subagent modules should not execute during discovery");\n',
        "subagents/researcher/lib/client.js":
          'throw new Error("subagent lib modules should not execute during discovery");\n',
        "subagents/researcher/sandbox/sandbox.js":
          'throw new Error("subagent sandboxes should not execute during discovery");\n',
        "subagents/researcher/subagents/reviewer/agent.js":
          'throw new Error("nested local subagent modules should not execute during discovery");\n',
        "subagents/researcher/subagents/reviewer/lib/review.js":
          'throw new Error("nested subagent lib modules should not execute during discovery");\n',
        "subagents/researcher/subagents/reviewer/sandbox/sandbox.mjs":
          'throw new Error("nested subagent sandboxes should not execute during discovery");\n',
        "subagents/researcher/subagents/reviewer/instructions.md": "Review drafts for clarity.",
        "subagents/researcher/instructions.md": "Research tasks thoroughly.",
        "subagents/researcher/tools/search.js":
          'throw new Error("subagent tools should not execute during discovery");\n',
        "instructions.md": "You are a routing assistant.",
      },
    });
    const appRoot = resolve(project.appRoot);
    const researcherRoot = join(resolve(project.agentRoot), "subagents", "researcher");
    const reviewerRoot = join(researcherRoot, "subagents", "reviewer");

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.manifest.subagents).toHaveLength(1);
    expect(result.manifest.subagents[0]).toMatchObject({
      entryPath: researcherRoot,
      logicalPath: "subagents/researcher",
      manifest: {
        agentId: "researcher",
        agentRoot: researcherRoot,
        appRoot,
        diagnosticsSummary: {
          errors: 0,
          warnings: 0,
        },
        lib: [
          {
            sourceKind: "module",
            logicalPath: "lib/client.js",
            sourceId: "lib/client.js",
          },
        ],
        instructions: [
          {
            definition: {
              markdown: "Research tasks thoroughly.",
            },
            sourceKind: "markdown",
            logicalPath: "instructions.md",
            sourceId: "instructions.md",
          },
        ],
        sandbox: {
          sourceKind: "module",
          logicalPath: "sandbox/sandbox.js",
          sourceId: "sandbox/sandbox.js",
        },
        configModule: {
          sourceKind: "module",
          logicalPath: "agent.mjs",
          sourceId: "agent.mjs",
        },
        tools: [
          {
            sourceKind: "module",
            logicalPath: "tools/search.js",
            sourceId: "tools/search.js",
          },
        ],
        version: 12,
      },
      rootPath: researcherRoot,
      sourceId: "subagents/researcher",
      subagentId: "researcher",
    });
    expect(result.manifest.subagents[0]?.manifest.subagents).toHaveLength(1);
    expect(result.manifest.subagents[0]?.manifest.subagents[0]).toMatchObject({
      entryPath: reviewerRoot,
      logicalPath: "subagents/reviewer",
      manifest: {
        agentId: "reviewer",
        agentRoot: reviewerRoot,
        appRoot,
        diagnosticsSummary: {
          errors: 0,
          warnings: 0,
        },
        lib: [
          {
            sourceKind: "module",
            logicalPath: "lib/review.js",
            sourceId: "lib/review.js",
          },
        ],
        instructions: [
          {
            definition: {
              markdown: "Review drafts for clarity.",
            },
            sourceKind: "markdown",
            logicalPath: "instructions.md",
            sourceId: "instructions.md",
          },
        ],
        sandbox: {
          sourceKind: "module",
          logicalPath: "sandbox/sandbox.mjs",
          sourceId: "sandbox/sandbox.mjs",
        },
        configModule: {
          sourceKind: "module",
          logicalPath: "agent.js",
          sourceId: "agent.js",
        },
        version: 12,
      },
      rootPath: reviewerRoot,
      sourceId: "subagents/reviewer",
      subagentId: "reviewer",
    });
  });

  it("discovers uppercase instructions in local subagent packages", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "instructions.md": "You route requests.",
        "subagents/researcher/agent.ts": "export default {};",
        "subagents/researcher/INSTRUCTIONS.MD": "Research carefully.",
      },
    });

    const result = await discoverAgent({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.manifest.subagents[0]?.manifest.instructions).toEqual([
      {
        definition: {
          markdown: "Research carefully.",
        },
        sourceKind: "markdown",
        logicalPath: "instructions.md",
        sourceId: "instructions.md",
      },
    ]);
  });

  it("discovers single-file subagents as parent-owned manifest entries", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "instructions.md": "You route requests.",
        "subagents/weather.ts":
          'throw new Error("single-file subagents should not execute during discovery");\n',
      },
    });
    const agentRoot = resolve(project.agentRoot);

    const result = await discoverSubagents({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.subagents).toHaveLength(1);
    expect(result.subagents[0]).toMatchObject({
      entryPath: join(agentRoot, "subagents", "weather.ts"),
      logicalPath: "subagents/weather.ts",
      manifest: {
        agentId: "weather",
        agentRoot,
        configModule: {
          logicalPath: "subagents/weather.ts",
          sourceId: "subagents/weather.ts",
          sourceKind: "module",
        },
      },
      rootPath: agentRoot,
      sourceId: "subagents/weather.ts",
      subagentId: "weather",
    });
  });

  it("reports missing local subagent config modules without dropping the subagent manifest", async () => {
    const project = buildMemoryAgentProject({
      agentDirectories: ["subagents/broken"],
    });

    const result = await discoverSubagents({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      DISCOVER_REQUIRED_SUBAGENT_CONFIG_MODULE_MISSING,
    ]);
    expect(result.subagents).toHaveLength(1);
    expect(result.subagents[0]).toMatchObject({
      logicalPath: "subagents/broken",
      manifest: {
        diagnosticsSummary: {
          errors: 1,
          warnings: 0,
        },
      },
      subagentId: "broken",
    });
  });

  it("rejects schedules inside local subagent packages", async () => {
    const project = buildMemoryAgentProject({
      agentDirectories: ["subagents/scheduled/schedules"],
      agentFiles: {
        "subagents/scheduled/agent.js": "export default {};\n",
        "subagents/scheduled/instructions.md": "Run background maintenance.",
      },
    });

    const result = await discoverSubagents({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      DISCOVER_LOCAL_SUBAGENT_SCHEDULES_INVALID,
    ]);
    expect(result.subagents[0]).toMatchObject({
      manifest: {
        diagnosticsSummary: {
          errors: 1,
          warnings: 0,
        },
        schedules: [],
      },
      subagentId: "scheduled",
    });
  });

  it("reports an invalid sandbox root inside local subagent packages", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "subagents/researcher/sandbox": "not-a-directory",
        "subagents/researcher/agent.js": "export default {};\n",
        "subagents/researcher/instructions.md": "Research tasks thoroughly.",
      },
    });

    const result = await discoverSubagents({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      DISCOVER_SANDBOX_DIRECTORY_INVALID,
    ]);
    expect(result.subagents[0]).toMatchObject({
      manifest: {
        diagnosticsSummary: {
          errors: 1,
          warnings: 0,
        },
        sandbox: null,
      },
      subagentId: "researcher",
    });
  });

  it("discovers file entries directly under subagents/ as single-file subagents", async () => {
    const project = buildMemoryAgentProject({
      agentFiles: {
        "subagents/stray.ts": "export default {};\n",
        "subagents/researcher/agent.js": "export default {};\n",
        "subagents/researcher/instructions.md": "Research tasks thoroughly.",
      },
    });
    const agentRoot = resolve(project.agentRoot);

    const result = await discoverSubagents({
      agentRoot: project.agentRoot,
      appRoot: project.appRoot,
      source: project.source,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.subagents).toHaveLength(2);
    expect(result.subagents.map((subagent) => subagent.subagentId)).toEqual([
      "researcher",
      "stray",
    ]);
    expect(result.subagents[1]).toMatchObject({
      logicalPath: "subagents/stray.ts",
      manifest: {
        configModule: {
          logicalPath: "subagents/stray.ts",
          sourceId: "subagents/stray.ts",
          sourceKind: "module",
        },
      },
      rootPath: agentRoot,
      subagentId: "stray",
    });
  });
});
