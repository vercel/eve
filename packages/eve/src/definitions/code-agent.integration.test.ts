import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createChannelAddress } from "#channel/channel-address.js";
import type { Runtime } from "#channel/types.js";
import { codeAgent } from "#definitions/code-agent.js";
import { defineDynamic } from "#dynamic/definition.js";
import { createInProcessRuntime } from "#execution/in-process/runtime.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { createStreamChecker, type Violation } from "#protocol/session-events/checker.js";
import { isStoredLine } from "#protocol/session-events/envelope.js";
import { schemaViolation } from "#protocol/session-events/schemas.js";
import { defineAgent } from "#public/definitions/agent.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { holdSessionAgent } from "#runtime/sessions/session-agent.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";

// An agent defined in code runs as the agent its files would compile to, on either host.

// Calls both tools in one step, then replies with how each came out.
const model = markMockModel(
  new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const results = prompt.flatMap((message) =>
        message.role === "tool"
          ? message.content.flatMap((part) =>
              part.type === "tool-result" ? [`${part.toolName}:${part.output.type}`] : [],
            )
          : [],
      );
      return results.length > 0
        ? textStreamResult(`Done: ${results.sort().join(", ")}.`)
        : toolCallsStreamResult([
            { input: "{}", toolCallId: "call-deploy", toolName: "deploy_change" },
            { input: "{}", toolCallId: "call-publish", toolName: "publish_change" },
          ]);
    },
    modelId: "code-agent-scripted",
    provider: "eve-test",
  }),
);

const approvedTool = (name: string, ran: string[]) =>
  defineTool({
    approval: always(),
    description: `Run ${name}.`,
    execute: async () => {
      ran.push(name);
      return { ran: name };
    },
    inputSchema: {},
  });

const address = (runtime: Runtime, continuationToken: string) =>
  createChannelAddress({
    adapter: { kind: "http" },
    channelName: "http",
    continuationToken,
    runtime,
  });

async function recorded(runtime: Runtime, sessionId: string): Promise<SessionStreamEvent[]> {
  const reader = (await runtime.getEventStream(sessionId, { follow: false })).getReader();
  const events: SessionStreamEvent[] = [];
  for (let next = await reader.read(); !next.done; next = await reader.read())
    events.push(next.value);
  return events;
}

async function violations(runtime: Runtime, sessionId: string): Promise<Violation[]> {
  const checker = createStreamChecker({ validate: schemaViolation });
  const found: Violation[] = [];
  let position = 0;
  for await (const record of await runtime.getLineStream(sessionId, { follow: false })) {
    if (!isStoredLine(record)) throw new Error(`Line ${position} isn't a stored line.`);
    found.push(...checker.check(record, position++));
  }
  return found;
}

/** Alice asks for both calls, approves one and denies the other. */
async function approveAndDeny(runtime: Runtime, token: string) {
  const alice = address(runtime, token);
  const asked = await (await alice.send("Deploy and publish.", { auth: null })).result();
  const answers = asked.interactions.map((interaction) => ({
    interactionId: interaction.interactionId,
    optionId: interaction.call?.callId === "call-deploy" ? "approve" : "deny",
  }));
  const answered = await (await alice.deliver({ answers }, { auth: null })).result();
  return {
    answered,
    events: await recorded(runtime, asked.sessionId),
    violations: await violations(runtime, asked.sessionId),
  };
}

/** Types and data with ids, times, revisions and agent names taken out. */
function shape(events: readonly SessionStreamEvent[]) {
  const ids = new Map<string, string>();
  const rename = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") {
      if (/(?:Id|Token|Name|revision)$/.test(key) || key === "id") {
        if (!ids.has(value)) ids.set(value, `<${ids.size}>`);
        return ids.get(value);
      }
      return /^\d{4}-\d{2}-\d{2}T/.test(value) ? "<time>" : value;
    }
    if (Array.isArray(value)) return value.map((entry) => rename(entry, key));
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([field]) => field !== "meta" && field !== "runtime")
          .map(([field, entry]) => [field, rename(entry, field)]),
      );
    return value;
  };
  return events.map((event) => rename({ data: event.data, type: event.type }));
}

describe("an agent defined in code", () => {
  it("runs as the agent its files would compile to, in process and on Workflow", async () => {
    const ran: string[] = [];
    const compiled = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
        }),
        name: "code-agent-files",
      },
      modules: ["deploy_change", "publish_change"].map((name) => ({
        loadNamespace: async () => ({ default: approvedTool(name, ran) }),
        logicalPath: `tools/${name}.ts`,
      })),
    });
    const agent = codeAgent({
      model: { model, modelContextWindowTokens: 200_000 },
      name: "code-agent",
      tools: {
        deploy_change: approvedTool("deploy_change", ran),
        publish_change: approvedTool("publish_change", ran),
      },
    });

    await compiled.run(async () => {
      const files = createInProcessRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      const inCode = createInProcessRuntime({ agent });
      const release = holdSessionAgent(agent);
      try {
        const fromFiles = await approveAndDeny(files, "alice-files");
        const here = await approveAndDeny(inCode, "alice-code");
        const deployed = await approveAndDeny(createWorkflowRuntime({ agent }), "alice-code-wf");

        expect(here.answered.reply).toBe(
          "Done: deploy_change:json, publish_change:execution-denied.",
        );
        expect(ran).toEqual(["deploy_change", "deploy_change", "deploy_change"]);
        expect(shape(here.events)).toEqual(shape(fromFiles.events));
        expect(shape(deployed.events)).toEqual(shape(here.events));
        expect(here.violations).toEqual([]);
        expect(deployed.violations).toEqual([]);
      } finally {
        release();
        await files.dispose();
        await inCode.dispose();
      }
    });
  });
});
