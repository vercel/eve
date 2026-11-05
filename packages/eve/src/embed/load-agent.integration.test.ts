import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { createChannelAddress } from "#channel/channel-address.js";
import { compileAgent } from "#compiler/compile-agent.js";
import { loadAgent } from "#embed/load-agent.js";
import { createSession } from "#embed/session.js";
import { createInProcessRuntime } from "#execution/in-process/runtime.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

// An `agent/` directory, compiled, and the same directory loaded by `loadAgent`, run in this
// process: the model sees the same requests.

const MODEL_GLOBAL = "__eveLoadAgentModel";

/** The fixture's `agent.ts` reads its model here: a test's recording mock. */
const dynamicModelSource = (extra = "") => `import { defineAgent, defineDynamic } from "eve";

export default defineAgent({
  ${extra}model: defineDynamic(() => ({
    model: (globalThis as Record<string, unknown>).${MODEL_GLOBAL},
    modelContextWindowTokens: 200_000,
  })),
});
`;

const FIXTURE: Readonly<Record<string, string>> = {
  "agent/agent.ts": dynamicModelSource(),
  "agent/instructions.md": "You are Ada, a release assistant.\n",
  "agent/tools/lookup.ts": `import { defineTool } from "eve/tools";

export default defineTool({
  description: "Look up a change.",
  execute: async () => ({ changes: 3 }),
  inputSchema: { type: "object", properties: {} },
});
`,
  "agent/skills/rollback.ts": `import { defineDynamic, defineSkill } from "eve/skills";

export default defineDynamic(() =>
  defineSkill({
    content: "Revert the release tag, then redeploy the previous build.",
    description: "Roll a release back.",
  }),
);
`,
  "agent/subagents/reviewer/agent.ts": dynamicModelSource('description: "Reviews a release.",\n  '),
  "agent/subagents/reviewer/instructions.md": "You review releases.\n",
};

type Call = { readonly prompt: unknown; readonly tools: readonly string[] };

/** A model that looks a change up, then answers, recording what each call sent. */
function recordingModel() {
  const calls: Call[] = [];
  const script = [
    () => toolCallStreamResult({ input: "{}", toolCallId: "call-lookup", toolName: "lookup" }),
    () => textStreamResult("Three changes."),
  ];
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async (options: LanguageModelV4CallOptions) => {
        calls.push({ prompt: options.prompt, tools: (options.tools ?? []).map((t) => t.name) });
        return script[Math.min(calls.length - 1, script.length - 1)]!();
      },
      modelId: "layout",
      provider: "eve-test",
    }),
  );
  return { calls, model };
}

/** Generated ids and times as placeholders, so two runs compare. */
function normalize(calls: readonly Call[]): unknown {
  return JSON.parse(
    JSON.stringify(calls)
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<time>")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
      .replace(/(?<![0-9A-Za-z])[0-9A-HJKMNP-TV-Z]{26}(?![0-9A-Za-z])/g, "<ulid>")
      .replace(
        /\b(?:sess|turn|req|call|del|int|task|agent|run|step|msg|evt)_[A-Za-z0-9]{8,}\b/g,
        "<id>",
      ),
  );
}

/** The requests an agent's session sends while Alice asks about the release. */
async function requestsOf(
  run: (ask: (message: string) => Promise<unknown>) => Promise<void>,
): Promise<readonly Call[]> {
  const recorded = recordingModel();
  (globalThis as Record<string, unknown>)[MODEL_GLOBAL] = recorded.model;
  await run(async (message) => message);
  return recorded.calls;
}

describe("loadAgent", () => {
  const createAppRoot = useTemporaryAppRoots();

  it("sends the model what the same directory sends compiled", async () => {
    const app = await createAppRoot("eve-load-agent-", { files: FIXTURE });

    const compiled = await requestsOf(async () => {
      await compileAgent({ startPath: app.appRoot });
      const runtime = createInProcessRuntime({
        compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(app.appRoot),
      });
      try {
        const alice = createChannelAddress({
          adapter: { kind: "http" },
          channelName: "http",
          continuationToken: "alice",
          runtime,
        });
        await (await alice.send("What's in the release?", { auth: null })).result();
      } finally {
        await runtime.dispose();
      }
    });
    const loaded = await requestsOf(async () => {
      const session = await createSession(await loadAgent(app.agentRoot), { identity: null });
      try {
        await (await session.send("What's in the release?")).result();
      } finally {
        await session.close();
      }
    });

    expect(compiled).toHaveLength(2);
    expect(compiled[0]!.tools).toEqual([
      "bash",
      "read_file",
      "write_file",
      "edit_file",
      "web_fetch",
      "agent",
      "lookup",
      "reviewer",
      "eve__task_wait",
      "eve__task_cancel",
      "eve__skill",
    ]);
    expect(normalize(loaded)).toEqual(normalize(compiled));
  });

  it("gives a static skill file to the agent as its skill, announced without a sandbox path", async () => {
    const app = await createAppRoot("eve-load-agent-skill-", {
      files: {
        "agent/agent.ts": dynamicModelSource(),
        "agent/instructions.md": "You are Ada.\n",
        "agent/skills/rollback.md":
          "---\ndescription: Roll a release back.\n---\n\nRevert the tag.\n",
      },
    });
    const loaded = await requestsOf(async () => {
      const session = await createSession(await loadAgent(app.agentRoot), { identity: null });
      try {
        await (await session.send("Roll it back.")).result();
      } finally {
        await session.close();
      }
    });
    expect(JSON.stringify(loaded[0]!.prompt)).toContain("- rollback: Roll a release back.");
    expect(JSON.stringify(loaded[0]!.prompt)).not.toContain("rollback/SKILL.md");
  });

  it("refuses what needs the agent's build, naming the file", async () => {
    const app = await createAppRoot("eve-load-agent-hooks-", {
      files: {
        "agent/agent.ts": dynamicModelSource(),
        "agent/instructions.md": "You are Ada.\n",
        "agent/hooks/audit.ts": "export default {};\n",
      },
    });
    await expect(loadAgent(app.agentRoot)).rejects.toThrow(
      "hooks/audit.ts needs the agent's build (eve build): hooks have no defineAgent field yet.",
    );
  });

  it("refuses a workflow tool when a session first asks for it", async () => {
    const app = await createAppRoot("eve-load-agent-workflow-", {
      files: {
        "agent/agent.ts": dynamicModelSource(),
        "agent/instructions.md": "You are Ada.\n",
        "agent/tools/ship.ts": `import { defineWorkflowTool } from "eve/tools";

export default defineWorkflowTool({
  description: "Ship.",
  inputSchema: { type: "object", properties: {} },
  async execute() {
    return { shipped: true };
  },
});
`,
      },
    });
    const agent = await loadAgent(app.agentRoot);
    const ship = agent.tools?.ship as (ctx: unknown) => Promise<unknown>;
    await expect(ship({})).rejects.toThrow(
      "tools/ship.ts is a workflow tool, which needs the agent's build (eve build)",
    );
  });
});
