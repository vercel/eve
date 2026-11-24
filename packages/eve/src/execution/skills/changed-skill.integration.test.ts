import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { createChannelAddress } from "#channel/channel-address.js";
import type { Runtime } from "#channel/types.js";
import type { AgentSourceOwner } from "#compiler/source-graph.js";
import { defineDynamic } from "#dynamic/definition.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import {
  textStreamResult,
  toolCallStreamResult,
  toolCallsStreamResult,
} from "#internal/testing/approval-resume.js";
import { createTestRuntime, type TestRuntime } from "#internal/testing/app-harness.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineSkill } from "#public/skills/index.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { setRuntimeSessionCompiledArtifacts } from "#runtime/sessions/runtime-session.js";

const NOTICE = "changed since you loaded it";

type Respond = (lastUserText: string, prompt: string) => ReturnType<typeof textStreamResult>;

function recordingModel(respond: Respond) {
  const prompts: { readonly input: string; readonly prompt: string }[] = [];
  const toolPrompts: string[] = [];
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async (options: LanguageModelV4CallOptions) => {
        const prompt = JSON.stringify(options.prompt);
        if (prompt.includes("CONTEXT CHECKPOINT COMPACTION")) return textStreamResult("Summary.");
        const last = options.prompt.at(-1);
        if (last?.role === "tool") {
          toolPrompts.push(prompt);
          return textStreamResult("Done.");
        }
        const input =
          last?.role === "user"
            ? last.content.map((part) => (part.type === "text" ? part.text : "")).join("")
            : "";
        prompts.push({ input, prompt });
        return respond(input, prompt);
      },
      modelId: "skills",
      provider: "eve-test",
    }),
  );
  return { model, prompts, toolPrompts };
}

async function deployment(
  model: unknown,
  skills: Readonly<Record<string, string>>,
  owners?: Readonly<Record<string, AgentSourceOwner>>,
): Promise<TestRuntime> {
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
      } as never),
      name: "changed-skill",
    },
    modules: Object.entries(skills).map(([name, content]) => ({
      loadNamespace: async () => ({
        default: defineSkill({ content, description: `The ${name} procedure.` }),
      }),
      logicalPath: `skills/${name}.ts`,
    })),
  });
  if (owners === undefined) return runtime;
  return {
    ...runtime,
    run: (fn) =>
      runtime.run(() => {
        const artifacts = runtime.session.compiledArtifacts!;
        const bindings = { ...artifacts.manifest.bindings };
        for (const { name, sourceId } of artifacts.manifest.skills) {
          const owner = owners[name];
          if (owner !== undefined) bindings[sourceId] = { ...bindings[sourceId]!, owner };
        }
        setRuntimeSessionCompiledArtifacts(runtime.session, {
          ...artifacts,
          manifest: { ...artifacts.manifest, bindings },
        });
        return fn();
      }),
  };
}

async function redeploy(current: TestRuntime, next: TestRuntime): Promise<void> {
  await next.run(() => {});
  setRuntimeSessionCompiledArtifacts(current.session, next.session.compiledArtifacts!);
}

async function conversation(
  first: TestRuntime,
  token: string,
  fn: (say: (text: string) => Promise<{ readonly sessionId: string }>, runtime: Runtime) => unknown,
): Promise<void> {
  await first.run(async () => {
    const runtime = createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    });
    const address = createChannelAddress({
      adapter: { kind: "http" },
      channelName: "http",
      continuationToken: token,
      runtime,
    });
    await fn(async (text) => await (await address.send(text, { auth: null })).result(), runtime);
  });
}

const notices = (prompt: string) => prompt.split(NOTICE).length - 1;
const loadSkill = (name: string, id: string) =>
  toolCallStreamResult({ input: JSON.stringify({ name }), toolCallId: id, toolName: "eve__skill" });

describe("a skill a new deployment changed", () => {
  it("keeps one reload notice across steps and turns, and leaves an unchanged skill alone", async () => {
    const { model, prompts, toolPrompts } = recordingModel((input, prompt) => {
      if (input === "Load the skills.") {
        return toolCallsStreamResult([
          {
            input: JSON.stringify({ name: "foo" }),
            toolCallId: "call-foo",
            toolName: "eve__skill",
          },
          {
            input: JSON.stringify({ name: "bar" }),
            toolCallId: "call-bar",
            toolName: "eve__skill",
          },
        ]);
      }
      if (input === "What next?" && prompt.includes("Skill `foo` changed")) {
        return loadSkill("foo", "call-foo-again");
      }
      return textStreamResult("Ok.");
    });
    const first = await deployment(model, { bar: "Bar procedure.", foo: "Foo procedure v1." });
    const second = await deployment(model, { bar: "Bar procedure.", foo: "Foo procedure v2." });

    await conversation(first, "changed-skill", async (say) => {
      await say("Load the skills.");
      await redeploy(first, second);
      await say("What next?");
      await say("Anything else?");
    });

    const [loaded, next, after] = prompts;
    expect(prompts.map(({ input }) => input)).toEqual([
      "Load the skills.",
      "What next?",
      "Anything else?",
    ]);
    expect(notices(loaded!.prompt)).toBe(0);
    expect(notices(next!.prompt)).toBe(1);
    expect(next!.prompt).toContain("Skill `foo` changed");
    const [, reloaded] = toolPrompts;
    expect(reloaded).toContain("Foo procedure v2.");
    expect(notices(reloaded!)).toBe(1);
    expect(notices(after!.prompt)).toBe(1);
    for (const { prompt } of prompts) expect(prompt).not.toContain("Skill `bar` changed");
  }, 90_000);

  it("notices updates from the same source and hides old notices when that source goes away", async () => {
    const names = ["guide", "review", "report"];
    const { model, prompts } = recordingModel((input) =>
      input === "Load the procedures."
        ? toolCallsStreamResult(
            names.map((name) => ({
              input: JSON.stringify({ name }),
              toolCallId: `call-${name}`,
              toolName: "eve__skill",
            })),
          )
        : textStreamResult("Ok."),
    );
    const extension = (namespace: string, packageName: string): AgentSourceOwner => ({
      kind: "extension",
      mountId: `extensions/${namespace}`,
      namespace,
      packageName,
    });
    const owners = {
      guide: { feature: "guide", kind: "framework" } as const,
      review: extension("review", "@example/review"),
      report: extension("report", "@example/report"),
    };
    const procedures = (revision: number) =>
      Object.fromEntries(names.map((name) => [name, `${name} procedure v${revision}.`]));
    const first = await deployment(model, procedures(1), owners);
    const second = await deployment(model, procedures(2), owners);
    const third = await deployment(
      model,
      { report: "Replacement procedure.", review: "review procedure v2." },
      {
        ...owners,
        report: extension("report", "@example/replacement-report"),
      },
    );

    await conversation(first, "changed-packaged-skill", async (say) => {
      await say("Load the procedures.");
      await redeploy(first, second);
      await say("What next?");
      await redeploy(first, third);
      await say("Anything else?");
    });

    const [, next, after] = prompts;
    expect(next!.input).toBe("What next?");
    for (const name of names) expect(next!.prompt).toContain(`Skill \`${name}\` changed`);
    expect(after!.input).toBe("Anything else?");
    expect(after!.prompt).toContain("Skill `review` changed");
    expect(after!.prompt).not.toContain("Skill `guide` changed");
    expect(after!.prompt).not.toContain("Skill `report` changed");
  }, 90_000);

  it("says nothing about a skill the new deployment removed", async () => {
    const { model, prompts } = recordingModel((input) =>
      input === "Load foo." ? loadSkill("foo", "call-foo") : textStreamResult("Ok."),
    );
    const first = await deployment(model, { bar: "Bar procedure.", foo: "Foo procedure v1." });
    const second = await deployment(model, { bar: "Bar procedure." });

    await conversation(first, "removed-skill", async (say) => {
      await say("Load foo.");
      await redeploy(first, second);
      await say("What next?");
    });

    expect(prompts.at(-1)!.input).toBe("What next?");
    for (const { prompt } of prompts) expect(notices(prompt)).toBe(0);
  }, 90_000);

  it("says nothing about a load that compaction already summarized", async () => {
    const { model, prompts } = recordingModel((input) =>
      input === "Load foo." ? loadSkill("foo", "call-foo") : textStreamResult("Ok."),
    );
    const first = await deployment(model, { foo: "Foo procedure v1." });
    const second = await deployment(model, { foo: "Foo procedure v2." });

    await conversation(first, "compacted-skill", async (say, runtime) => {
      const { sessionId } = await say("Load foo.");
      for (let turn = 1; turn <= 6; turn += 1) await say(`Filler ${turn}.`);
      await runtime.dispatchSession({
        command: { deliveryId: "compacted-skill-compact", kind: "compact" },
        sessionId,
      });
      await redeploy(first, second);
      await say("What next?");
    });

    const last = prompts.at(-1)!;
    expect(last.input).toBe("What next?");
    expect(last.prompt).not.toContain("Foo procedure v1.");
    expect(notices(last.prompt)).toBe(0);
  }, 90_000);
});
