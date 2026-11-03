import { describe, expect, it } from "vitest";

import { compileAgent } from "#compiler/compile-agent.js";
import { createNodeHarnessTools } from "#execution/node-step.js";
import { loadCompiledModuleMapFromAuthoredSource } from "#internal/authored-module-map-loader.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { resolveRuntimeAgentGraph } from "#runtime/resolve-agent-graph.js";

import { workflowEntry } from "#execution/session/entry.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext, withTimeout } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineTool } from "#tools/definition.js";

const ALICE = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "alice",
  principalType: "user" as const,
};

function tool(tags?: readonly string[]) {
  return defineTool({
    description: "Look up an issue for Alice.",
    execute: () => ({ ok: true }),
    inputSchema: {},
    tags,
  });
}

const createAppRoot = useTemporaryAppRoots();

describe("entry tags", () => {
  it("records a tool's tags on call.requested and gives them to the approval policy", async () => {
    const seen: Record<string, readonly string[] | undefined> = {};
    const runtime = await createTestRuntime({
      agent: {
        definition: defineAgent({
          approval: ({ toolName, toolTags }) => {
            seen[toolName] = toolTags;
            return undefined;
          },
          model: "openai/gpt-5.4",
        }),
        name: "entry-tags",
      },
      modules: [
        {
          loadNamespace: async () => ({ default: tool(["reads:untrusted", "reads:untrusted"]) }),
          logicalPath: "tools/read_issue.ts",
        },
        { loadNamespace: async () => ({ default: tool() }), logicalPath: "tools/list_labels.ts" },
      ],
    });

    await runtime.run(async () => {
      const run = await startSessionOwner(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: {
            message: "Call tools in parallel: read_issue, list_labels",
          },
          serializedContext: buildSerializedContext({
            auth: ALICE,
            channelKind: "http",
            continuationToken: "http:entry-tags",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        const turn = await withTimeout(stream.nextTurn(), "tagged calls");
        const requested = Object.fromEntries(
          filterEventsByType(turn, "call.requested").map(({ data }) => [
            data.capability.name,
            data.capability.tags,
          ]),
        );
        const expected = { list_labels: undefined, read_issue: ["reads:untrusted"] };
        expect({ requested, seen }).toEqual({ requested: expected, seen: expected });
        expect(Object.keys(requested).sort()).toEqual(Object.keys(expected).sort());
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);

  it("tags the parent's calls to a subagent and a remote agent", async () => {
    const app = await createAppRoot("eve-entry-tags-", {
      files: {
        "agent/agent.mjs":
          'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });',
        "agent/instructions.md": "Help Alice with issues.\n",
        "agent/subagents/researcher/instructions.md": "Research issues for Alice.\n",
        "agent/subagents/researcher/agent.mjs": [
          'import { defineAgent } from "eve";',
          "export default defineAgent({",
          '  model: "openai/gpt-5.4",',
          '  description: "Researches issues.",',
          '  tags: ["reads:untrusted"],',
          "});",
        ].join("\n"),
        "agent/subagents/billing.mjs": [
          'import { defineRemoteAgent } from "eve";',
          "export default defineRemoteAgent({",
          '  description: "Handles billing questions.",',
          '  tags: ["effect:external"],',
          '  url: "https://billing.example.com",',
          "});",
        ].join("\n"),
      },
    });

    await compileAgent({ startPath: app.appRoot });
    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(app.appRoot);
    const [manifest, moduleMap] = await Promise.all([
      loadCompiledManifest({ compiledArtifactsSource }),
      loadCompiledModuleMapFromAuthoredSource({ compiledArtifactsSource }),
    ]);
    const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });
    const tools = createNodeHarnessTools({ node: graph.root });

    expect({
      billing: tools.get("billing")?.tags,
      researcher: tools.get("researcher")?.tags,
    }).toEqual({ billing: ["effect:external"], researcher: ["reads:untrusted"] });
  }, 60_000);
});
