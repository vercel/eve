import { describe, expect, it } from "vitest";

import { runWorkflowProgram } from "#execution/code-mode/workflow-program.js";
import { installWorkflowSandboxRuntime } from "#internal/nitro/host/workflow-sandbox-runtime.js";
import type { DeliveryResult } from "#shared/delivery.js";

// As eve's host does for an agent with a `workflow()` tool.
installWorkflowSandboxRuntime();

type Reply = (target: string, message: string, outputSchema: unknown) => unknown;

/**
 * The context of one `workflow()` call whose agents answer with `reply`: a string is the agent's
 * reply, any other value its structured data, and a throw its failed turn. `sent` records each
 * message an agent received.
 */
function workflowCall(reply: Reply, abort = new AbortController()) {
  const sent: { target: string; message: string; outputSchema?: unknown }[] = [];
  const result = async (
    target: string,
    message: string,
    outputSchema: unknown,
  ): Promise<DeliveryResult> => {
    sent.push({ message, outputSchema, target });
    const settled = {
      data: undefined,
      deliveryId: "delivery",
      interactions: [],
      outcome: "handled",
      reply: undefined,
      sessionEnded: false,
      sessionId: "child",
    } as const;
    try {
      const output = await reply(target, message, outputSchema);
      return typeof output === "string"
        ? { ...settled, reply: output, status: "completed" }
        : { ...settled, data: output, status: "completed" };
    } catch (error) {
      return {
        ...settled,
        error: { code: "MODEL_FAILED", message: (error as Error).message },
        status: "failed",
      };
    }
  };
  // Only what a program's run reads of its call's context.
  const ctx = {
    abortSignal: abort.signal,
    agent: (target: string) => ({
      send: async (message: string, options: { outputSchema?: unknown }) => ({
        result: () => result(target, message, options.outputSchema),
      }),
    }),
    callId: "call-workflow",
    toolName: "workflow",
  } as never;
  return { abort, ctx, sent };
}

describe("a workflow() program", () => {
  it("fans out to agents, feeds their replies to the next, and returns one value with its logs and counts", async () => {
    const { ctx, sent } = workflowCall((target, message) =>
      target === "ticket-triage" ? { urgent: 2 } : `${target} read "${message}"`,
    );
    const outputSchema = { properties: { urgent: { type: "number" } }, type: "object" };

    const result = await runWorkflowProgram(
      {
        code: `
          const [notes, triage] = await Promise.all([
            tools.researcher({ message: "one" }),
            tools["ticket-triage"]({ message: "two", outputSchema: ${JSON.stringify(outputSchema)} }),
          ]);
          console.log("triaged", triage);
          return await tools.writer({ message: notes + " / " + triage.urgent });
        `,
      },
      ctx,
    );

    expect(result).toEqual({
      calls: { completed: 3 },
      logs: ['triaged {"urgent":2}'],
      result: 'writer read "researcher read "one" / 2"',
    });
    // The first two agents ran side by side; the third got what they replied.
    expect(sent).toEqual([
      { message: "one", outputSchema: undefined, target: "researcher" },
      { message: "two", outputSchema, target: "ticket-triage" },
      { message: 'researcher read "one" / 2', outputSchema: undefined, target: "writer" },
    ]);
  });

  it("lets the program catch a failed agent and a call it can't make, none of which reaches an agent", async () => {
    const { ctx, sent } = workflowCall(() => {
      throw new Error("the reviewer's model refused");
    });

    const result = await runWorkflowProgram(
      {
        code: `
          const caught = [];
          for (const call of [
            () => tools.reviewer({ message: "review" }),
            () => tools.reviewer({ prompt: "review" }),
            () => tools.reviewer({ message: "again", taskId: "task_1" }),
            () => tools.reviewer({ message: "typed", outputSchema: "object" }),
            () => search({ query: "agents" }),
          ]) {
            try { await call(); } catch (error) { caught.push(error.message); }
          }
          return caught;
        `,
      },
      ctx,
    );

    expect(result).toEqual({
      calls: { failed: 1 },
      result: [
        'Agent "reviewer" failed to handle the message: the reviewer\'s model refused',
        '"reviewer" takes a message string. Call an agent as tools.reviewer({ message, outputSchema? }).',
        '"reviewer" takes no "taskId": each call starts a new agent session. Call an agent as tools.reviewer({ message, outputSchema? }).',
        '"reviewer" takes outputSchema as a JSON Schema object.',
        "search() isn't available in a workflow program, which calls agents only: tools.<agent>({ message }).",
      ],
    });
    expect(sent.map(({ message }) => message)).toEqual(["review"]);
  });

  it("holds a program to its author's agent limit across batches", async () => {
    const { ctx, sent } = workflowCall((_target, message) => message);

    const result = await runWorkflowProgram(
      {
        code: `
          const first = await tools.researcher({ message: "one" });
          const rest = await Promise.allSettled([
            tools.researcher({ message: "two" }),
            tools.researcher({ message: "three" }),
          ]);
          return [first, ...rest.map((call) => call.value ?? call.reason.message)];
        `,
        maxSubagents: 2,
      },
      ctx,
    );

    expect(result).toEqual({
      calls: { completed: 2, failed: 1 },
      result: [
        "one",
        "two",
        'EXECUTE_AGENT_LIMIT_REACHED: a program may call agents at most 2 times; "researcher" was not called.',
      ],
    });
    expect(sent.map(({ message }) => message)).toEqual(["one", "two"]);
  });

  it("fails its task with the program's error, the line that threw, and what it logged", async () => {
    const { ctx } = workflowCall(() => "sent");

    await expect(
      runWorkflowProgram(
        {
          code: `await tools.mailer({ message: "send it" });\nconsole.log("sent one");\nthrow new Error("no recipients left");`,
        },
        ctx,
      ),
    ).rejects.toThrow(
      "Error: no recipients left (line 3) Calls that completed before this are not undone.\nconsole output:\nsent one",
    );
  });

  it("fails a program that returns while an agent call is still pending", async () => {
    const { ctx } = workflowCall(() => "late");

    await expect(
      runWorkflowProgram({ code: `tools.researcher({ message: "one" }); return "early";` }, ctx),
    ).rejects.toThrow("Await every call before returning");
  });

  it("stops for good when its task is cancelled while an agent works", async () => {
    const abort = new AbortController();
    const { ctx, sent } = workflowCall(() => {
      abort.abort(new Error("the task was cancelled"));
      throw new Error("the child stopped");
    }, abort);

    await expect(
      runWorkflowProgram(
        {
          code: `try { await tools.researcher({ message: "one" }); } catch {} return await tools.researcher({ message: "two" });`,
        },
        ctx,
      ),
    ).rejects.toThrow("the task was cancelled");
    expect(sent.map(({ message }) => message)).toEqual(["one"]);
  });

  it("rejects input the tool's own definition would never send, before any program runs", async () => {
    const { ctx } = workflowCall(() => "unused");

    await expect(runWorkflowProgram({ code: 42 as never }, ctx)).rejects.toThrow(
      'workflow requires a "code" string.',
    );
    await expect(runWorkflowProgram({ code: "return 1", maxSubagents: 129 }, ctx)).rejects.toThrow(
      "workflow maxSubagents must be an integer between 1 and 128.",
    );
  });
});
