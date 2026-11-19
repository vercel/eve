import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChannelAddress } from "#channel/channel-address.js";
import { defineDynamic } from "#dynamic/definition.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createStatefulMcpServer } from "#internal/testing/stateful-mcp-server.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineInstructions } from "#public/instructions/index.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { requestPublicUrl } from "#execution/web-fetch/request.js";
import { defineTool } from "#tools/definition.js";
import { offloadContent } from "#tools/offload-content.js";
import { webFetch } from "#tools/provided/web-fetch.js";

vi.mock("#execution/web-fetch/request.js", () => ({ requestPublicUrl: vi.fn() }));

const ISSUES = Array.from({ length: 100 }, (_, index) => ({
  body: `Body of issue ${index}. `.repeat(250),
  labels: [{ name: "bug" }, { name: "regression" }],
  number: index + 1,
  state: index % 4 === 0 ? "closed" : "open",
  title: `Issue ${index + 1}`,
  user: { login: `user${index}` },
}));
const ISSUES_JSON = JSON.stringify(ISSUES);
const OPEN = ISSUES.filter((issue) => issue.state === "open").length;
const NOTE_PATH = /\/tmp\/\.eve\/tool-results\/[^\s"\\]+\.json/;

const mod = (logicalPath: string, value: unknown) => ({
  loadNamespace: async () => ({ default: value }),
  logicalPath,
});

function scriptedModel(
  steps: readonly ((prompt: string) => ReturnType<typeof textStreamResult>)[],
) {
  const prompts: string[] = [];
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async (options: LanguageModelV4CallOptions) => {
        const prompt = JSON.stringify(
          options.prompt.filter((message) => message.role !== "system"),
        );
        prompts.push(prompt);
        return steps[prompts.length - 1]!(prompt);
      },
      modelId: "offload",
      provider: "eve-test",
    }),
  );
  return { model, prompts };
}

async function runTurn(input: {
  readonly modules: readonly ReturnType<typeof mod>[];
  readonly model: unknown;
  readonly name: string;
}) {
  const test = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => ({ model: input.model, modelContextWindowTokens: 200_000 })),
      } as never),
      name: input.name,
    },
    modules: [
      mod("instructions/agent.ts", defineInstructions({ content: "You are a triage assistant." })),
      ...input.modules,
    ],
  });
  await test.run(async () => {
    const runtime = createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    });
    const address = createChannelAddress({
      adapter: { kind: "http" },
      channelName: "http",
      continuationToken: input.name,
      runtime,
    });
    await (await address.send("How many of these issues are open?", { auth: null })).result();
  });
}

function approxTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text) / 4);
}

describe("offloadContent on a real turn", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function readerTool(read: { text?: string }) {
    return mod(
      "tools/read_result.ts",
      defineTool({
        description: "Read a saved tool result and count its open issues.",
        execute: async (input, ctx) => {
          const { path } = input as { path: string };
          const sandbox = await ctx.getSandbox();
          read.text = (await sandbox.readTextFile({ path })) ?? undefined;
          const items = JSON.parse(read.text ?? "[]") as { state: string }[];
          return { open: items.filter((item) => item.state === "open").length };
        },
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      }),
    );
  }

  function scriptAfterResult(
    call: () => ReturnType<typeof toolCallStreamResult>,
    read: { text?: string },
  ) {
    return [
      call,
      (prompt: string) => {
        const path = NOTE_PATH.exec(prompt)?.[0];
        if (path === undefined) throw new Error("The next model request has no saved-result note.");
        return toolCallStreamResult({
          input: JSON.stringify({ path }),
          toolCallId: "call-read",
          toolName: "read_result",
        });
      },
      (prompt: string) => {
        expect(prompt).toContain(`"open":${OPEN}`);
        expect(read.text).toBe(ISSUES_JSON);
        return textStreamResult(`${OPEN} issues are open.`);
      },
    ];
  }

  it("keeps a large authored tool result out of the next model request", async () => {
    const read: { text?: string } = {};
    const { model, prompts } = scriptedModel(
      scriptAfterResult(
        () =>
          toolCallStreamResult({ input: "{}", toolCallId: "call-list", toolName: "list_issues" }),
        read,
      ),
    );
    await runTurn({
      model,
      modules: [
        mod(
          "tools/list_issues.ts",
          defineTool({
            description: "List the repository's issues.",
            execute: async () => ISSUES,
            inputSchema: {},
            toModelOutput: offloadContent({ maxBytes: 80_000 }),
          }),
        ),
        readerTool(read),
      ],
      name: "offload-authored",
    });
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).not.toContain("Body of issue 50.");
    const note = /The result of list_issues[\s\S]*?read_file\./.exec(prompts[1]!)?.[0] ?? "";
    expect(approxTokens(note)).toBeLessThan(300);
    expect(approxTokens(prompts[1]!) + 1).toBeLessThan(approxTokens(ISSUES_JSON) / 20);
  });

  it("offloads the output of the built-in web_fetch when its definition is spread", async () => {
    const page = Array.from(
      { length: 100 },
      (_, index) => `line ${index} ${"x".repeat(2_000)}`,
    ).join("\n");
    vi.mocked(requestPublicUrl).mockResolvedValue(
      new Response(page, { headers: { "content-type": "text/plain" } }),
    );
    const read: { text?: string } = {};
    const { model, prompts } = scriptedModel([
      () =>
        toolCallStreamResult({
          input: JSON.stringify({ url: "https://docs.example.com/big" }),
          toolCallId: "call-fetch",
          toolName: "web_fetch",
        }),
      (prompt) => {
        const path = NOTE_PATH.exec(prompt)?.[0];
        if (path === undefined) throw new Error("The next model request has no saved-result note.");
        return toolCallStreamResult({
          input: JSON.stringify({ path }),
          toolCallId: "call-read",
          toolName: "read_result",
        });
      },
      () => textStreamResult("done"),
    ]);
    await runTurn({
      model,
      modules: [
        mod(
          "tools/web_fetch.ts",
          defineTool({ ...webFetch, toModelOutput: offloadContent({ maxBytes: 8_000 }) }),
        ),
        readerTool(read),
      ],
      name: "offload-web-fetch",
    });
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).not.toContain("line 10 ");
    const saved = JSON.parse(read.text ?? "{}") as { content: string; truncated: boolean };
    expect(saved.truncated).toBe(true);
    expect(saved.content).toContain("line 10 ");
    expect(saved.content).not.toContain("line 99 ");
  });

  it("keeps a large MCP tool result out of the next model request", async () => {
    vi.stubGlobal(
      "fetch",
      createStatefulMcpServer((server) => {
        server.registerTool("list_issues", { description: "List the issues." }, () => ({
          content: [{ text: ISSUES_JSON, type: "text" }],
        }));
      }).fetch,
    );
    const read: { text?: string } = {};
    const { model, prompts } = scriptedModel([
      () =>
        toolCallStreamResult({
          input: JSON.stringify({ query: "issues__list" }),
          toolCallId: "call-search",
          toolName: "eve__search",
        }),
      ...scriptAfterResult(
        () =>
          toolCallStreamResult({
            input: JSON.stringify({ input: {}, name: "issues__list_issues" }),
            toolCallId: "call-list",
            toolName: "eve__tool",
          }),
        read,
      ),
    ]);
    await runTurn({
      model,
      modules: [
        mod(
          "connections/issues.ts",
          defineMcpClientConnection({
            description: "Repository issues.",
            toolCall: { toModelOutput: offloadContent({ maxBytes: 80_000 }) },
            url: "https://issues.example.com/mcp",
          }),
        ),
        readerTool(read),
      ],
      name: "offload-mcp",
    });
    expect(prompts).toHaveLength(4);
    expect(prompts[2]).not.toContain("Body of issue 50.");
    const note =
      /The result of issues__list_issues[\s\S]*?read_file\./.exec(prompts[2]!)?.[0] ?? "";
    expect(approxTokens(note)).toBeLessThan(300);
  });
});
