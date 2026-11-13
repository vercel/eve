import type * as Eve from "eve";
import type * as RuntimeSubagentConfig from "../node_modules/eve/dist/src/runtime/subagents/dynamic-agent-config.js";
import type * as RuntimeContext from "../node_modules/eve/dist/src/context/container.js";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import browserAgent from "@agent/subagents/browser-agent/agent";
import { dynamicContextFor, evaluateDynamic } from "@tests/helpers/dynamic";

vi.mock("eve", async (importOriginal) => ({
  ...(await importOriginal<typeof Eve>()),
  defineDynamic: <T>(fn: T) => fn,
}));

// Use the same normalization boundary as real delegation; calling the authored
// resolver alone does not validate which fields Eve accepts at runtime.
const { normalizeDynamicSubagentAgentConfig } = await vi.importActual<
  typeof RuntimeSubagentConfig
>(
  new URL(
    "./runtime/subagents/dynamic-agent-config.js",
    import.meta.resolve("eve")
  ).pathname
);
const { ContextContainer } = await vi.importActual<typeof RuntimeContext>(
  new URL("./context/container.js", import.meta.resolve("eve")).pathname
);

describe("worker input bubbling", () => {
  it("keeps native questions disabled inside browser workers", () => {
    expect(
      existsSync("agent/subagents/browser-agent/tools/ask_question.ts")
    ).toBe(false);
  });

  it("accepts the selected browser worker through Eve's runtime normalization", async () => {
    const worker = await evaluateDynamic(
      browserAgent,
      dynamicContextFor({
        channel: { kind: "channel:linq", metadata: {} },
        sessionId: "worker-test",
      })
    );
    await expect(
      normalizeDynamicSubagentAgentConfig({
        modelMetadata: async () => ({
          fetchedAt: null,
          kind: "eve-model-metadata",
          models: [
            {
              providers: [
                {
                  contextWindowTokens: 128_000,
                  provider: "meta",
                  providerModelId: "muse-spark-1.3",
                },
              ],
              slug: "meta/muse-spark-1.3",
            },
          ],
          providerAliases: {},
          version: 1,
        }),
        name: "browser-agent",
        value: worker,
        state: new ContextContainer(),
      })
    ).resolves.toMatchObject({ model: { id: "meta/muse-spark-1.3" } });
  });

  it("ends the worker turn and routes the answer through its task id", () => {
    const instructions = readFileSync(
      "agent/instructions/content/role/interactive.md",
      "utf8"
    );
    const workerInstructions = readFileSync(
      "agent/subagents/browser-agent/instructions.md",
      "utf8"
    );

    expect(instructions).toContain(
      "continue that worker with its `run_browser` `taskId`"
    );
    expect(instructions).toContain(
      "Before surfacing a `Needs user input:` blocker"
    );
    expect(instructions).toContain(
      "confirm the worker explicitly reported checking compatible vault items"
    );
    expect(workerInstructions).toContain(
      "Before returning `Needs user input:` or `Needs vault setup:`"
    );
    expect(workerInstructions).toContain("select the relevant compatible item");
    expect(workerInstructions).toContain(
      "structured completion tool Eve supplies"
    );
    expect(workerInstructions).toContain(
      "Follow the structured completion tool's instructions"
    );
  });
});
