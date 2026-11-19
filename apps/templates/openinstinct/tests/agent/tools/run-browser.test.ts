import type {
  AgentMessageResult,
  AgentResponse,
  AgentSendOptions,
  AgentSession,
  WorkflowServeCall,
  WorkflowServeContext,
} from "eve/tools";
import { describe, expect, it, vi } from "vitest";
import runBrowser from "@agent/tools/run_browser";
import { toolContextFor } from "@tests/helpers/tool-context";

type WorkerMessage = Parameters<AgentSession["send"]>[0];

const completion = {
  status: "success",
  message: "Verified the page heading.",
  images: [],
};

const outputSchema = {
  type: "object",
  required: ["images", "status", "message"],
  properties: {
    images: { type: "array", maxItems: 4 },
    status: { enum: ["success", "failure"] },
  },
};

class ReceiveDrained extends Error {}

/**
 * Runs the serve loop over `calls` with a mocked worker session. The loop is
 * open-ended by design, so it ends when `receive()` has no more calls.
 */
async function serveCalls(
  calls: readonly WorkflowServeCall<{ message: string }>[],
  results: readonly (AgentMessageResult | Error)[]
) {
  const queue = [...calls];
  const pending = [...results];
  const send = vi.fn<
    (
      message: WorkerMessage,
      options?: AgentSendOptions
    ) => Promise<AgentResponse>
  >(async () => {
    const next = pending.shift();
    if (!next) throw new Error("No worker result was scripted.");
    return {
      result: async () => {
        if (next instanceof Error) throw next;
        return next;
      },
    };
  });
  // SAFETY: The worker returns untyped JSON that run_browser parses itself, so
  // the mock's unparameterized output stands in for every requested TOutput.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- AgentSession.send is generic over the caller's output type.
  const session = { send } as AgentSession;
  const agent = vi.fn<WorkflowServeContext["agent"]>(() => session);
  const reply = vi.fn<WorkflowServeContext["reply"]>();
  const {
    abortSignal: _abortSignal,
    callId: _callId,
    ...shared
  } = toolContextFor();
  const mocks = { agent, reply, send };
  try {
    await runBrowser.serve(
      async () => {
        const call = queue.shift();
        if (!call) throw new ReceiveDrained();
        return call;
      },
      {
        ...shared,
        agent,
        agents: {},
        ask: vi.fn<WorkflowServeContext["ask"]>(),
        reply,
      }
    );
    return { ...mocks, error: undefined };
  } catch (error) {
    return { ...mocks, error };
  }
}

function serveCall(
  message: string,
  abortSignal = new AbortController().signal
): WorkflowServeCall<{ message: string }> {
  return { abortSignal, callId: `call-${message}`, input: { message } };
}

function completed(data: Partial<typeof completion>): AgentMessageResult {
  return { data, reply: "", sessionEnded: false, status: "completed" };
}

describe("structured browser workflow", () => {
  it("supplies the completion schema on initial and continued calls to one worker", async () => {
    const { agent, error, reply, send } = await serveCalls(
      [serveCall("Inspect the heading"), serveCall("Inspect the footer")],
      [completed(completion), completed(completion)]
    );

    expect(error).toBeInstanceOf(ReceiveDrained);
    expect(agent).toHaveBeenCalledExactlyOnceWith("browser-agent");
    expect(send).toHaveBeenCalledTimes(2);
    for (const [index, message] of [
      "Inspect the heading",
      "Inspect the footer",
    ].entries()) {
      expect(send.mock.calls[index]).toMatchObject([message, { outputSchema }]);
    }
    expect(reply.mock.calls).toEqual([[completion], [completion]]);
  });

  it("rejects malformed completion instead of reporting success", async () => {
    const { error, reply } = await serveCalls(
      [serveCall("Inspect the heading")],
      [completed({ status: "success", message: "Done" })]
    );

    expect(error).not.toBeInstanceOf(ReceiveDrained);
    expect(String(error)).toMatch(/images/u);
    expect(reply).not.toHaveBeenCalled();
  });

  it("reports a failed worker turn as a structured failure", async () => {
    const { error, reply } = await serveCalls(
      [serveCall("Inspect the heading")],
      [
        {
          data: undefined,
          error: { message: "Kernel unavailable" },
          reply: "",
          sessionEnded: false,
          status: "failed",
        },
      ]
    );

    expect(error).toBeInstanceOf(ReceiveDrained);
    expect(reply).toHaveBeenCalledExactlyOnceWith({
      images: [],
      message: "Browser worker failed: Kernel unavailable",
      status: "failure",
    });
  });

  it("keeps the worker available after a cancelled stretch", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const { error, reply, send } = await serveCalls(
      [
        serveCall("Inspect the heading", cancelled.signal),
        serveCall("Inspect the footer"),
      ],
      [new Error("aborted"), completed(completion)]
    );

    expect(error).toBeInstanceOf(ReceiveDrained);
    expect(send).toHaveBeenCalledTimes(2);
    expect(reply).toHaveBeenCalledExactlyOnceWith(completion);
  });
});
