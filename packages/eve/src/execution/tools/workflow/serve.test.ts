import { expect, it, vi } from "vitest";

import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import { AgentSessions } from "#execution/agent-sessions/session.js";
import type { WorkflowBodyInput } from "#execution/tools/workflow/body.js";
import type {
  WorkflowToolRunControlMessage,
  WorkflowToolRunMessage,
} from "#execution/tools/workflow/messages.js";
import { startServeBody } from "#execution/tools/workflow/serve.js";
import type { JsonValue } from "#shared/json.js";
import type {
  WorkflowServeCall,
  WorkflowServeContext,
  WorkflowServeReceive,
} from "#tools/workflow-definition.js";

const mocks = vi.hoisted(() => ({
  deliver: vi.fn<(inbox: string, message: WorkflowToolRunMessage) => Promise<void>>(),
  serve: vi.fn(),
}));
vi.mock("#execution/workflow-registry.js", () => ({ readRegisteredWorkflow: () => mocks.serve }));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({
  resumeHookStep: mocks.deliver,
}));

const agentContext = { capabilities: { requestInput: true } } as AgentSessionContext;
const input: WorkflowBodyInput = {
  agentContext,
  callId: "call-1",
  entry: { entryPoint: "serve", taskId: "plan-7k2m9q" },
  input: { request: "Draft the plan." },
  owner: { inbox: "inbox" },
  runId: "run",
  session: {
    auth: { current: null, initiator: null },
    id: "session",
    turn: { id: "turn", sequence: 1 },
  },
  stepIndex: 0,
  toolName: "plan",
  workflowId: "workflow//test//plan",
};

function call(callId: string, request: string): WorkflowToolRunControlMessage {
  return { call: { callId, input: { request } }, kind: "call" };
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
}

it("serves every call to its task, one stretch of work at a time, until the session ends", async () => {
  const received: WorkflowServeCall<JsonValue>[] = [];
  const pendings: Promise<WorkflowServeCall<JsonValue>>[] = [];
  mocks.serve.mockImplementation(
    async (receive: WorkflowServeReceive<JsonValue>, ctx: WorkflowServeContext<JsonValue>) => {
      received.push(await receive());
      const pending = receive();
      pendings.push(pending, receive());
      received.push(await pending);
      ctx.reply("revised plan");
      const third = await receive();
      received.push(third);
      await aborted(third.abortSignal);
      received.push(await receive());
      return await receive();
    },
  );
  const agentSessions = new AgentSessions({ context: agentContext, from: {} as never, inbox: "" });
  const started = startServeBody(input, agentSessions);

  await vi.waitFor(() => expect(pendings).toHaveLength(2));
  started.control.apply(call("call-2", "Add a rollback step."));
  await vi.waitFor(() => expect(mocks.deliver).toHaveBeenCalledTimes(2));
  started.control.apply(call("call-3", "Move it to Friday."));
  await vi.waitFor(() => expect(received).toHaveLength(3));
  started.control.apply({ kind: "cancel", reason: "The task was cancelled." });
  started.control.apply(call("call-4", "Keep it on Thursday."));
  await vi.waitFor(() => expect(received).toHaveLength(4));
  started.control.apply({ kind: "end", reason: "The session ended." });

  await expect(started.result).resolves.toEqual({
    messageCount: 2,
    outcome: { reason: "The session ended.", status: "cancelled" },
  });
  expect(pendings[0]).toBe(pendings[1]);
  expect(received.map(({ callId, input }) => ({ callId, input }))).toEqual([
    { callId: "call-1", input: { request: "Draft the plan." } },
    { callId: "call-2", input: { request: "Add a rollback step." } },
    { callId: "call-3", input: { request: "Move it to Friday." } },
    { callId: "call-4", input: { request: "Keep it on Thursday." } },
  ]);
  const replies = mocks.deliver.mock.calls.map(([inbox, message]) => ({
    callId: message.from.callId,
    inbox,
    output: message.kind === "reply" ? message.output : undefined,
  }));
  expect(replies).toEqual([
    { callId: "call-1", inbox: "inbox", output: "revised plan" },
    { callId: "call-2", inbox: "inbox", output: "revised plan" },
  ]);
  const [first, second, third, fourth] = received.map((served) => served.abortSignal);
  // A call that arrives while the task works joins its stretch; a cancel ends
  // only that stretch, and the next call starts a new one.
  expect(second).toBe(first);
  expect(third).not.toBe(first);
  expect(third?.aborted).toBe(true);
  expect(fourth).not.toBe(third);
  expect(first?.aborted).toBe(false);
  expect(fourth?.aborted).toBe(true);
});
