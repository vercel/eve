import { jsonSchema } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import { createKernel } from "#harness/tool-loop.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { foldingHandler, withOpenTurn } from "#internal/testing/session-machine.js";

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

describe("tool-result media staging", () => {
  // #4839: staging runs after the step's model call and tools, so a throw
  // there fails the step and its retry replays both.
  it("keeps the step when the sandbox rejects the write of a returned file", async () => {
    const execute = vi.fn(async () => ({ chart: "iVBORw0KGgo=" }));
    const doStream = vi.fn<MockLanguageModelV4["doStream"]>(async () => ({
      stream: convertArrayToReadableStream([
        { type: "tool-call", toolCallId: "inspect-1", toolName: "inspect", input: "{}" },
        { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
      ]),
    }));
    const step = createKernel({
      handleEvent: foldingHandler(),
      resolveModel: async () => new MockLanguageModelV4({ doStream }),
      tools: new Map([
        [
          "inspect",
          {
            description: "Render a chart",
            execute,
            inputSchema: jsonSchema({ type: "object" }),
            name: "inspect",
            toModelOutput: (output) => ({
              type: "content",
              value: [
                {
                  data: { data: (output as { chart: string }).chart, type: "data" },
                  filename: "chart.png",
                  mediaType: "image/png",
                  type: "file",
                },
              ],
            }),
          },
        ],
      ]),
    });
    const sandbox = mockSandbox();
    const ctx = new ContextContainer();
    ctx.set(SandboxKey, {
      ...sandbox.access,
      open: async () => ({
        ...sandbox.session,
        writeBinaryFile: async () => {
          throw new Error("sandbox is past its timeout");
        },
      }),
    });
    const session = withOpenTurn(
      {
        agent: { modelReference: { id: "media-test" }, system: "Test assistant", tools: [] },
        compaction: { recentWindowSize: 10, threshold: 100_000 },
        continuationToken: "http:media-test",
        sessionId: "media-test",
        history: [],
      },
      { sequence: 1, turnId: "media-turn" },
    );
    enterSessionProjection(ctx, session.state);

    const result = await contextStorage.run(ctx, () =>
      step(session, { message: "Render the chart." }),
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(doStream).toHaveBeenCalledOnce();
    const history = JSON.stringify(result.session.history);
    expect(history).toContain("Returned file chart.png (image/png) could not be stored.");
    expect(history).not.toContain("iVBORw0KGgo=");
  });
});
