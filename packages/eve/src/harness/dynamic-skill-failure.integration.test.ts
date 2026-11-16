import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it } from "vitest";

import { createChannelAddress } from "#channel/channel-address.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult } from "#internal/testing/approval-resume.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineDynamic as defineDynamicModel } from "#public/definitions/model.js";
import { defineDynamic, defineSkill } from "#public/skills/index.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

it("keeps the user's request when a dynamic skill fails before the first model call", async () => {
  const prompts: LanguageModelV4CallOptions["prompt"][] = [];
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        prompts.push(prompt);
        return textStreamResult("Done.");
      },
      modelId: "dynamic-skill-failure",
      provider: "eve-test",
    }),
  );
  let unavailable = true;
  const test = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamicModel(() => ({ model, modelContextWindowTokens: 200_000 })),
      }),
      name: "dynamic-skill-failure",
    },
    modules: [
      {
        loadNamespace: async () => ({
          default: defineDynamic(() => {
            if (unavailable) throw new Error("Skill storage temporarily unavailable.");
            return defineSkill({ description: "Prepare a release.", content: "Check QA first." });
          }),
        }),
        logicalPath: "skills/release.ts",
      },
    ],
  });

  await test.run(async () => {
    const runtime = createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    });
    const address = createChannelAddress({
      adapter: { kind: "http" },
      channelName: "http",
      continuationToken: "dynamic-skill-failure",
      runtime,
    });
    const request = "Prepare the release notes for Alice.";
    const failed = await (await address.send(request, { auth: null })).result();
    expect(failed).toMatchObject({ status: "failed", error: { code: "REACTION_FAILED" } });
    expect(prompts).toHaveLength(0);

    unavailable = false;
    const retried = await (await address.send("Try again.", { auth: null })).result();
    expect(retried).toMatchObject({ status: "completed", sessionId: failed.sessionId });
    expect(prompts).toHaveLength(1);
    const userMessages = prompts[0]!.filter((message) => message.role === "user");
    expect(JSON.stringify(userMessages)).toContain("Try again.");
    expect(JSON.stringify(userMessages)).toContain(request);
  });
});
