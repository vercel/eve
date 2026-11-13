import { jsonSchema, type LanguageModel, type ModelMessage } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { eventsOf } from "#harness/publication.js";
import { cascade } from "#harness/session-machine/cascade.js";
import type {
  HarnessSession,
  HarnessStepInput,
  SessionPublication,
  StepResult,
} from "#harness/types.js";
import { contextStorage } from "#context/container.js";
import { fact } from "#harness/facts.js";
import { commitOf } from "#harness/session-machine/commit.js";
import { foldPublication } from "#harness/session-machine/current.js";
import { createApprovalContext } from "#internal/testing/approval-resume.js";
import { createTestKernel } from "#internal/testing/kernel.js";
import { createStreamChecker } from "#protocol/session-events/checker.js";
import { emptySessionView, foldReceivedEvent } from "#protocol/session-projection/fold.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { defineHarness, type Harness } from "#public/definitions/harness.js";

// A harness's stages, end to end through the kernel: what the model reads and is offered, what
// happens next in the turn, and what the history becomes. Every fact is checked against the
// stream contract, so a harness can't make a stream a client couldn't follow.

type StreamPart =
  Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

const usage = {
  inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 1, total: 1 },
  outputTokens: { reasoning: undefined, text: 1, total: 1 },
};

function text(value: string): StreamPart[] {
  return [
    { id: "text", type: "text-start" },
    { delta: value, id: "text", type: "text-delta" },
    { id: "text", type: "text-end" },
    { finishReason: { raw: undefined, unified: "stop" }, type: "finish", usage },
  ];
}

function tool(name: string, overrides: Record<string, unknown> = {}) {
  return {
    description: `The ${name} tool.`,
    execute: async () => ({ ok: true }),
    inputSchema: jsonSchema({ type: "object" }),
    name,
    ...overrides,
  };
}

/** A session of an agent with `harness`, whose model writes `replies` in order. */
function harnessed(
  harness: Harness,
  replies: string[],
  options: {
    readonly tools?: readonly ReturnType<typeof tool>[];
    readonly outputSchema?: HarnessSession["outputSchema"];
    /** Runs in a session a person can be asked in, as approvals need. */
    readonly askable?: boolean;
  } = {},
) {
  const ctx = options.askable === true ? createApprovalContext() : undefined;
  const model = new MockLanguageModelV4({
    doStream: async () => ({ stream: convertArrayToReadableStream(text(replies.shift() ?? "")) }),
  });
  const checker = createStreamChecker();
  const written = emptySessionView();
  const violations: unknown[] = [];
  const facts: SessionEvent[] = [];
  let position = 0;
  const onPublish = async (publication: SessionPublication) => {
    if (ctx !== undefined) foldPublication(ctx, publication);
    const committed = cascade(written, eventsOf(publication));
    for (const fact of committed) {
      foldReceivedEvent(written, { ...fact, meta: { endOfLine: false } });
    }
    facts.push(...committed);
    violations.push(
      ...checker.check({ at: "2026-11-12T00:00:00.000Z", facts: committed }, position++),
    );
  };
  const kernel = createTestKernel({
    agent: { harness, model: { id: "harnessed" } },
    ...(ctx !== undefined && { capabilities: { requestInput: true } }),
    handleEvent: onPublish,
    resolveModel: async (): Promise<LanguageModel> => model,
    tools: new Map(
      [tool("bash"), tool("echo"), ...(options.tools ?? [])].map((entry) => [entry.name, entry]),
    ),
  });
  const runStep: typeof kernel = (current, input) =>
    ctx === undefined
      ? kernel(current, input)
      : contextStorage.run(ctx, () => kernel(current, input));
  let session: HarnessSession = {
    compaction: {},
    continuationToken: "http:harnessed",
    history: [],
    sessionId: "harnessed",
    ...(options.outputSchema !== undefined && { outputSchema: options.outputSchema }),
  };
  /** Runs a turn for `input` (a message, or answers) until it stops. */
  const turn = async (input: string | HarnessStepInput): Promise<StepResult> => {
    // The session's inbox admits the deliveries an input names before its step runs.
    for (const { deliveryId } of typeof input === "string" ? [] : (input.answers ?? [])) {
      await onPublish(commitOf([fact("delivery.admitted", { deliveryId })]));
    }
    let result = await runStep(session, typeof input === "string" ? { message: input } : input);
    for (let steps = 0; typeof result.next === "function" && steps < 10; steps += 1) {
      const next = result.next;
      const current = result.session;
      result = await (ctx === undefined
        ? next(current)
        : contextStorage.run(ctx, () => next(current)));
    }
    session = result.session;
    return result;
  };
  const prompts = () => model.doStreamCalls.map(({ prompt }) => prompt);
  return { facts, model, prompts, session: () => session, turn, violations };
}

function textOf(message: { readonly content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  return (message.content as readonly { type: string; text?: string }[])
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
}

describe("next", () => {
  it("answers a slash command without the model, as the turn's reply", async () => {
    const run = harnessed(
      defineHarness({
        next: (ctx, below) =>
          ctx.input === "/help" ? { settle: "Ask about plans. /deploy deploys." } : below(),
      }),
      ["Hello!"],
    );

    const help = await run.turn("/help");
    expect(help.settledTurn).toEqual({ output: "Ask about plans. /deploy deploys." });
    expect(run.prompts()).toHaveLength(0);
    expect(run.facts).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          phase: "reply",
          value: "Ask about plans. /deploy deploys.",
        }),
        type: "content.completed",
      }),
    );

    // The next turn's model reads the exchange the harness answered.
    await run.turn("hi");
    expect(run.prompts()).toHaveLength(1);
    expect(run.prompts()[0]!.map((message) => [message.role, textOf(message)])).toEqual(
      expect.arrayContaining([
        ["user", "/help"],
        ["assistant", "Ask about plans. /deploy deploys."],
        ["user", "hi"],
      ]),
    );
    expect(run.violations).toEqual([]);
  });

  it("sends the model back with a note, reading eve's own answer below it", async () => {
    const run = harnessed(
      defineHarness({
        next: async (ctx, below) => {
          const action = await below();
          if (!("settle" in action) || ctx.continuations > 0) return action;
          return { model: { note: "Cite a source for each claim." } };
        },
      }),
      ["Paris is the capital.", "Paris is the capital [1]."],
    );

    const result = await run.turn("What's the capital of France?");

    expect(result.settledTurn).toEqual({ output: "Paris is the capital [1]." });
    expect(run.prompts()).toHaveLength(2);
    expect(textOf(run.prompts()[1]!.at(-1)!)).toBe("Cite a source for each claim.");
    expect(run.violations).toEqual([]);
  });

  it("fails the turn rather than loop the model on nothing new", async () => {
    const run = harnessed(defineHarness({ next: () => ({ model: {} }) }), ["Once."]);

    const result = await run.turn("hi");

    expect(result.settledTurn).toEqual(expect.objectContaining({ isError: true }));
    expect(run.prompts()).toHaveLength(1);
    expect(run.violations).toEqual([]);
  });
});

describe("request stages", () => {
  it("changes one call as it's sent, never what's recorded", async () => {
    const run = harnessed(
      defineHarness({
        request: async (_ctx, below) => {
          const request = await below();
          return {
            ...request,
            messages: [
              ...request.messages,
              { content: "You are talking to a viewer.", role: "user" } satisfies ModelMessage,
            ],
            tools: new Map([...request.tools].filter(([name]) => name !== "bash")),
          };
        },
      }),
      ["Hi, viewer."],
    );

    await run.turn("hi");

    expect(textOf(run.prompts()[0]!.at(-1)!)).toBe("You are talking to a viewer.");
    expect(run.session().history.map(textOf)).not.toContain("You are talking to a viewer.");
    const offered = (run.model.doStreamCalls[0]!.tools ?? []).map((entry) => entry.name);
    expect(offered).toContain("echo");
    expect(offered).not.toContain("bash");
    expect(run.violations).toEqual([]);
  });

  it("fails the turn when a request offers a tool the call doesn't have", async () => {
    const run = harnessed(
      defineHarness({
        request: async (_ctx, below) => {
          const request = await below();
          const made = { deferred: false, description: "Made up.", name: "made_up" };
          return { ...request, tools: new Map([...request.tools, ["made_up", made]]) };
        },
      }),
      ["unused"],
    );

    const result = await run.turn("hi");

    expect(result.settledTurn).toEqual(expect.objectContaining({ isError: true }));
    expect(run.prompts()).toHaveLength(0);
  });

  it("places a turn's context ahead of its input, kept for later calls", async () => {
    let asked = 0;
    const run = harnessed(
      defineHarness({
        context: async (_ctx, below) => {
          asked += 1;
          return [...(await below()), { content: "Recalled: likes tea.", role: "user" }];
        },
        next: async (ctx, below) => {
          const action = await below();
          if (!("settle" in action) || ctx.continuations > 0) return action;
          return { model: { note: "Once more." } };
        },
      }),
      ["First.", "Second."],
      // A context the session carries from step to step, as a deployed session's does.
      { askable: true },
    );

    await run.turn("What do I drink?");

    expect(asked).toBe(1);
    for (const prompt of run.prompts()) {
      const texts = prompt.filter((message) => message.role === "user").map(textOf);
      const recalled = texts.indexOf("Recalled: likes tea.");
      expect(recalled).toBeGreaterThanOrEqual(0);
      expect(texts[recalled + 1]).toBe("What do I drink?");
    }
    expect(run.session().history.map(textOf)).not.toContain("Recalled: likes tea.");
  });

  it("filters the tools and adds to the instructions", async () => {
    const run = harnessed(
      defineHarness({
        instructions: "Answer in one paragraph.",
        tools: async (_ctx, below) =>
          new Map([...(await below())].filter(([name]) => name !== "bash")),
      }),
      ["Done."],
    );

    await run.turn("hi");

    const offered = (run.model.doStreamCalls[0]!.tools ?? []).map((entry) => entry.name);
    expect(offered).toContain("echo");
    expect(offered).not.toContain("bash");
    const system = run
      .prompts()[0]!
      .filter((message) => message.role === "system")
      .map(textOf);
    expect(system.join("\n")).toContain("Answer in one paragraph.");
  });
});

describe("compact", () => {
  it("rewrites the history its own way, as a compaction", async () => {
    const run = harnessed(
      defineHarness({
        compact: (ctx) => {
          const last = ctx.history.at(-1);
          if (ctx.history.length <= 2 || last === undefined) return undefined;
          return [{ content: "Earlier: they greeted each other.", role: "user" }, last];
        },
      }),
      ["Hello!", "Fine, thanks."],
    );

    await run.turn("hi");
    await run.turn("how are you?");

    expect(
      run
        .prompts()[1]!
        .filter((message) => message.role !== "system")
        .map(textOf),
    ).toEqual(["Earlier: they greeted each other.", "how are you?"]);
    expect(run.facts.map((fact) => fact.type)).toContain("context.settled");
    expect(run.violations).toEqual([]);
  });
});

describe("extends: false", () => {
  it("runs a turn with nothing of eve's below it", async () => {
    const run = harnessed(
      defineHarness({
        extends: false,
        next: (ctx) =>
          ctx.lastStep === undefined
            ? { model: {} }
            : { settle: (ctx.lastStep.text ?? "").toUpperCase() },
      }),
      ["hello"],
    );

    const result = await run.turn("hi");

    expect(result.settledTurn).toEqual({ output: "HELLO" });
    expect(run.violations).toEqual([]);
  });

  it("fails the turn when a naked layer calls below()", async () => {
    const run = harnessed(defineHarness({ extends: false, next: (_ctx, below) => below() }), [
      "unused",
    ]);

    const result = await run.turn("hi");

    expect(result.settledTurn).toEqual(expect.objectContaining({ isError: true }));
    expect(run.prompts()).toHaveLength(0);
  });
});

describe("call", () => {
  it("runs a slash command's tool through the gate, then settles from its output", async () => {
    const released: unknown[] = [];
    const release = tool("release", {
      execute: async (input: unknown) => {
        released.push(input);
        return { url: "https://example.com/1.2.0" };
      },
      inputSchema: jsonSchema({
        properties: { version: { type: "string" } },
        required: ["version"],
        type: "object",
      }),
    });
    const run = harnessed(
      defineHarness({
        next: (ctx, below) => {
          const version = /^\/release (\S+)$/.exec(ctx.input)?.[1];
          if (version === undefined) return below();
          const call = ctx.calls.find((entry) => entry.tool === "release");
          if (call === undefined) return { call: [{ input: { version }, tool: "release" }] };
          if (call.status !== "settled") return below();
          return call.outcome === "completed"
            ? { settle: `Released ${version}: ${(call.output as { url: string }).url}` }
            : { fail: `The release was ${call.outcome}.` };
        },
      }),
      ["unused"],
      { tools: [release] },
    );

    const result = await run.turn("/release 1.2.0");

    expect(released).toEqual([{ version: "1.2.0" }]);
    expect(result.settledTurn).toEqual({ output: "Released 1.2.0: https://example.com/1.2.0" });
    expect(run.prompts()).toHaveLength(0);
    expect(run.facts).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ owner: { turnId: expect.any(String) } }),
        type: "call.requested",
      }),
    );
    expect(run.violations).toEqual([]);
  });

  it("parks a harness's call on approval, as it would a model's", async () => {
    const run = harnessed(
      defineHarness({
        next: (ctx, below) => {
          if (ctx.input !== "/wipe") return below();
          const call = ctx.calls.find((entry) => entry.tool === "wipe");
          if (call === undefined) return { call: [{ tool: "wipe" }] };
          return call.status === "settled" ? { settle: `Wipe ${call.outcome}.` } : below();
        },
      }),
      ["unused"],
      { askable: true, tools: [tool("wipe", { approval: () => true })] },
    );

    const parked = await run.turn("/wipe");
    expect(parked.held).toBeDefined();
    const opened = run.facts.find((fact) => fact.type === "interaction.opened");
    expect(opened).toBeDefined();

    // Approved, the call runs, and the harness reads its result before any model would.
    const settled = await run.turn({
      answers: [
        {
          deliveryId: "d-approve",
          interactionId: (opened!.data as { interactionId: string }).interactionId,
          optionId: "approve",
          responseId: "r-approve",
        },
      ],
    });
    expect(settled.settledTurn).toEqual({ output: "Wipe completed." });
    expect(run.prompts()).toHaveLength(0);
    expect(run.violations).toEqual([]);
  });

  it("shows the model the harness's calls as the framework's, not its own", async () => {
    const run = harnessed(
      defineHarness({
        next: (ctx, below) => {
          if (ctx.input !== "/status" || ctx.lastStep !== undefined) return below();
          const call = ctx.calls.find((entry) => entry.tool === "echo");
          if (call === undefined) return { call: [{ tool: "echo" }] };
          return call.status === "settled" ? { model: {} } : below();
        },
      }),
      ["All good."],
    );

    const result = await run.turn("/status");

    expect(result.settledTurn).toEqual({ output: "All good." });
    const prompt = run.prompts()[0]!;
    expect(prompt.some((message) => message.role === "tool")).toBe(false);
    expect(prompt.map(textOf).join("\n")).toMatch(/harness made these calls itself.*echo/s);
    // History keeps them as calls, for the gate.
    expect(run.session().history.some((message) => message.role === "tool")).toBe(true);
    expect(run.violations).toEqual([]);
  });

  it("refuses a call to a tool that isn't there", async () => {
    const run = harnessed(defineHarness({ next: () => ({ call: [{ tool: "nope" }] }) }), []);

    const result = await run.turn("hi");

    expect(result.settledTurn).toEqual(expect.objectContaining({ isError: true }));
    expect(run.violations).toEqual([]);
  });
});

describe("structured settle", () => {
  const outputSchema = {
    properties: { answer: { type: "string" } },
    required: ["answer"],
    type: "object",
  };

  it("settles a structured turn with a value its schema accepts", async () => {
    const run = harnessed(defineHarness({ next: () => ({ settle: { answer: "42" } }) }), [], {
      outputSchema,
    });

    const result = await run.turn("What is it?");

    expect(result.settledTurn).toEqual({ output: { answer: "42" } });
    expect(run.facts).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ kind: "result", value: { answer: "42" } }),
        type: "content.completed",
      }),
    );
    expect(run.violations).toEqual([]);
  });

  it("fails one its schema rejects", async () => {
    const run = harnessed(defineHarness({ next: () => ({ settle: { wrong: true } }) }), [], {
      outputSchema,
    });

    const result = await run.turn("What is it?");

    expect(result.settledTurn).toEqual(expect.objectContaining({ isError: true }));
    expect(run.violations).toEqual([]);
  });
});

describe("admit", () => {
  it("records that the harness admits, so the session loop asks it about each message", async () => {
    const run = harnessed(defineHarness({ admit: () => ({ action: "queue" }) }), ["Hi."]);

    await run.turn("hi");

    expect(run.session().state?.["eve.harness.admits"]).toBe(true);
  });

  it("records nothing for a harness without the stage", async () => {
    const run = harnessed(defineHarness({ instructions: "Be brief." }), ["Hi."]);

    await run.turn("hi");

    expect(run.session().state?.["eve.harness.admits"]).toBeUndefined();
  });
});

describe("notes", () => {
  it("counts a turn's notes in the session, not its history", async () => {
    const run = harnessed(
      defineHarness({
        next: async (ctx, below) => {
          const action = await below();
          if (!("settle" in action) || ctx.continuations > 1) return action;
          return { model: { note: `Note ${ctx.continuations + 1}.` } };
        },
      }),
      ["One.", "Two.", "Three."],
    );

    const result = await run.turn("hi");

    expect(result.settledTurn).toEqual({ output: "Three." });
    expect(run.session().state?.["eve.harness.notes"]).toEqual(
      expect.objectContaining({ count: 2 }),
    );
  });
});

describe("wait", () => {
  it("fails a wait on tasks that don't work, rather than hold the turn forever", async () => {
    const run = harnessed(defineHarness({ next: () => ({ wait: { tasks: ["nothing-1"] } }) }), []);

    const result = await run.turn("hi");

    expect(result.settledTurn).toEqual(expect.objectContaining({ isError: true }));
    expect(result.held).toBeUndefined();
  });
});

describe("compact's view of eve's threshold", () => {
  it("says whether eve would compact, without compacting", async () => {
    const seen: { pastThreshold: boolean; requested: boolean }[] = [];
    const run = harnessed(
      defineHarness({
        compact: (ctx) => {
          seen.push({ pastThreshold: ctx.pastThreshold, requested: ctx.requested });
          return undefined;
        },
      }),
      ["Hi."],
    );

    await run.turn("hi");

    expect(seen).toEqual([{ pastThreshold: false, requested: false }]);
    expect(run.facts.map((fact) => fact.type)).not.toContain("context.started");
  });
});
