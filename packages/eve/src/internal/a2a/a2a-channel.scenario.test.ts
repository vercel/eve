import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  materializeScenarioApp,
  type ScenarioAppDescriptor,
} from "#internal/testing/scenario-app.js";
import { startEveDev, type RunningEveDev } from "#internal/testing/dev-server-harness.js";
import { encodeTaskId } from "#internal/a2a/ids.js";
import { requiredRecord, requiredString } from "#internal/testing/scenario-values.js";

/** A production build that runs the scenario's own `mockModel`. */
const SCENARIO_ENV = { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" };

const SETUP_TIMEOUT_MS = 360_000;
const TEST_TIMEOUT_MS = 60_000;
const OPERATION_TIMEOUT_MS = 30_000;
const A2A_AGENT_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const model = mockModel(async (request) => {
  const last = request.lastUserMessage ?? "";
  if (last.includes("A2A-SLOW")) {
    // A long one keeps its task working well past a loaded runner's slowest follow-up.
    await new Promise((resolve) => setTimeout(resolve, last.includes("A2A-SLOW-LONG") ? 8_000 : 2_000));
    return "A2A-SLOW-DONE";
  }
  if (last.startsWith("A2A-ECHO")) return \`ECHO:\${last}\`;
  if (last.includes("A2A-APPROVE")) {
    return request.toolResults.some((result) => result.name === "guarded")
      ? "A2A-APPROVED"
      : { toolCalls: [{ id: "guard-1", input: {}, name: "guarded" }] };
  }
  const prompt = JSON.stringify(request.messages);
  if (prompt.includes("A2A-CUSTOM-FAILURE")) {
    throw new Error("A2A-CUSTOM-FAILURE: token sk-live-123 rejected.");
  }
  if (prompt.includes("A2A-FAILURE-PROBE")) {
    throw new Error(
      "A2A-FAILURE-PROBE: provider rejected the request.\\n<!DOCTYPE html><html><body>edge-internal-7f</body></html>",
    );
  }
  const answered = request.toolResults.some((result) => result.name === "ask_question");
  if (prompt.includes("A2A-ASK") && !answered) {
    return {
      toolCalls: [{
        id: "question-1",
        input: {
          options: [
            { description: "Continue the delegated work.", label: "Yes" },
            { description: "Stop before the delegated work.", label: "No" },
          ],
          question: "Proceed with the delegated work?",
        },
        name: "ask_question",
      }],
    };
  }
  return answered ? "A2A-LIFECYCLE-COMPLETE" : "A2A-QUICK-REPLY";
});

export default defineAgent({
  description: "Exercises the A2A task lifecycle.",
  model,
  modelContextWindowTokens: 32_000,
});
`,
    "agent/channels/a2a.ts": `import { withAuthChallenges } from "eve/channels/auth";
import { a2aChannel } from "eve/channels/a2a";

export default a2aChannel({
  auth: withAuthChallenges((request) => {
    const principalId = request.headers.get("x-test-principal");
    if (principalId === null) return null;
    // The principal none() gives every unauthenticated caller.
    if (principalId === "anonymous") {
      return { attributes: {}, authenticator: "none", principalId, principalType: "anonymous" };
    }
    return { attributes: {}, authenticator: "scenario", principalId, principalType: "user" };
  }, [{ scheme: "Bearer" }]),
  // Rewrites one failure; an empty string leaves the rest to the default.
  failureText: (failure) =>
    failure.message.startsWith("A2A-CUSTOM-FAILURE") ? \`Delegation failed (\${failure.id ?? "no id"}).\` : "",
  maxBlockingMs: 10_000,
  uploadPolicy: { allowedMediaTypes: ["image/*"] },
});
`,
    "agent/instructions.md": "Follow the deterministic mock-model lifecycle.\n",
    "agent/tools/guarded.ts": `import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";

export default defineTool({
  approval: always(),
  description: "A guarded action that needs a person's approval.",
  execute: () => ({ ok: true }),
  inputSchema: { properties: {}, type: "object" },
});
`,
    "agent/tools/ask_question.ts":
      'import { askQuestion } from "eve/tools/ask_question";\n\nexport default askQuestion;\n',
  },
  dependencies: { "just-bash": "3.4.2" },
  installDependencies: true,
  name: "a2a-agent-channel",
};

let app: Awaited<ReturnType<typeof materializeScenarioApp>> | undefined;
let server: RunningEveDev | undefined;

function url(): string {
  if (server === undefined) throw new Error("eve dev is not running.");
  return server.url;
}

describe("A2A channel", () => {
  beforeAll(async () => {
    app = await materializeScenarioApp(A2A_AGENT_DESCRIPTOR);
    server = await startEveDev(app.appRoot, { env: SCENARIO_ENV });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
    await app?.cleanup().catch(() => {});
  });

  it(
    "serves a public Agent Card describing the JSON-RPC interface",
    async () => {
      const response = await fetch(new URL("/.well-known/agent-card.json", url()));
      expect(response.ok).toBe(true);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.json()).toMatchObject({
        capabilities: { pushNotifications: false, streaming: true },
        defaultInputModes: ["text/plain", "application/json", "image/*"],
        description: "Exercises the A2A task lifecycle.",
        securityRequirements: [{ schemes: { bearer: { list: [] } } }],
        securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } },
        supportedInterfaces: [
          {
            protocolBinding: "JSONRPC",
            protocolVersion: "1.0",
            url: new URL("/eve/v1/a2a", url()).toString(),
          },
        ],
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses unauthenticated calls, other versions, unknown tasks, and disallowed files",
    async () => {
      const anonymous = await fetch(new URL("/eve/v1/a2a", url()), {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "GetTask", params: { id: "x" } }),
        headers: { "a2a-version": "1.0", "content-type": "application/json" },
        method: "POST",
      });
      expect(anonymous.status).toBe(401);

      // The protocol's own refusals are unit-tested (json-rpc.test.ts); these need the server:
      // the version header reaching the handler, the ownership lookup, and the upload policy.
      expect(rpcErrorCode(await rpc("alice", "GetTask", { id: "x" }, { version: null }))).toBe(
        -32009,
      );
      expect(rpcErrorCode(await rpc("alice", "GetTask", { id: "not-a-task" }))).toBe(-32001);
      expect(
        rpcErrorCode(
          await rpc("alice", "SendMessage", {
            message: {
              messageId: "pdf-1",
              parts: [{ mediaType: "application/pdf", raw: "JVBERi0=" }],
              role: "ROLE_USER",
            },
          }),
        ),
      ).toBe(-32005);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "runs a task through input-required to completion, isolated per principal",
    async () => {
      const task = await sendTask("alice", { message: userMessage("ask-1", "A2A-ASK") });
      expect(task.status).toMatchObject({
        message: { role: "ROLE_AGENT" },
        state: "TASK_STATE_INPUT_REQUIRED",
      });
      // The prompt is plain text any client can read and answer; eve's interaction JSON stays
      // off the wire.
      const promptParts = requiredRecord(requiredRecord(task.status, "status").message, "message")
        .parts as Record<string, unknown>[];
      expect(promptParts).toHaveLength(1);
      expect(promptParts[0]?.text).toContain("Proceed with the delegated work?");
      expect(promptParts[0]?.text).toContain("Yes");
      const taskId = requiredString(task.id, "task.id");
      const contextId = requiredString(task.contextId, "task.contextId");

      // Another principal can't see the task or use the context.
      expect(rpcErrorCode(await rpc("bob", "GetTask", { id: taskId }))).toBe(-32001);
      expect(
        rpcErrorCode(
          await rpc("bob", "SendMessage", { message: { ...userMessage("b-1", "hi"), contextId } }),
        ),
      ).toBe(-32602);

      // A task ID decodes to any delivery: one that names no A2A message is no task, even in a
      // context the caller owns.
      const phantom = encodeTaskId({ deliveryId: "not-an-a2a-message", sessionId: contextId });
      for (const method of ["GetTask", "SubscribeToTask", "CancelTask"]) {
        expect(rpcErrorCode(await rpc("alice", method, { id: phantom }))).toBe(-32001);
      }

      // A typed answer on the same task resumes it.
      const done = await sendTask("alice", {
        message: { ...userMessage("ask-2", "Yes"), contextId, taskId },
      });
      expect(done).toMatchObject({
        artifacts: [{ parts: [{ text: "A2A-LIFECYCLE-COMPLETE" }] }],
        contextId,
        id: taskId,
        status: { state: "TASK_STATE_COMPLETED" },
      });

      // A retried messageId is the same task, even now that it is terminal.
      const retried = await sendTask("alice", {
        message: { ...userMessage("ask-2", "Yes"), contextId, taskId },
      });
      expect(retried).toMatchObject({ id: taskId, status: { state: "TASK_STATE_COMPLETED" } });
      const retriedFirst = await sendTask("alice", {
        configuration: { returnImmediately: true },
        message: userMessage("ask-1", "A2A-ASK"),
      });
      expect(retriedFirst.id).toBe(taskId);

      // A terminal task takes no new messages, and can't be cancelled.
      expect(
        rpcErrorCode(
          await rpc("alice", "SendMessage", {
            message: { ...userMessage("ask-3", "again"), contextId, taskId },
          }),
        ),
      ).toBe(-32004);
      expect(rpcErrorCode(await rpc("alice", "CancelTask", { id: taskId }))).toBe(-32002);

      // History holds the task's user messages.
      const read = requiredRecord((await rpc("alice", "GetTask", { id: taskId })).result, "task");
      // History echoes the client's message IDs.
      expect((read.history as { messageId: string }[]).map((m) => m.messageId)).toEqual([
        "ask-1",
        "ask-2",
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers a prompt by option number, and lists a context's tasks newest first",
    async () => {
      const first = await sendTask("alice", { message: userMessage("x-1", "A2A-ASK") });
      const contextId = requiredString(first.contextId, "contextId");

      const answered = await sendTask("alice", {
        message: { ...userMessage("x-3", "1"), contextId, taskId: first.id },
      });
      expect(answered).toMatchObject({
        artifacts: [{ parts: [{ text: "A2A-LIFECYCLE-COMPLETE" }] }],
        id: first.id,
        status: { state: "TASK_STATE_COMPLETED" },
      });

      // A follow-up in the context is a second task; a retry of it is the same task.
      const second = await sendTask("alice", {
        message: { ...userMessage("x-4", "Another question"), contextId },
      });
      expect(second.id).not.toBe(first.id);
      expect(second).toMatchObject({ contextId, status: { state: "TASK_STATE_COMPLETED" } });
      const secondAgain = await sendTask("alice", {
        message: { ...userMessage("x-4", "Another question"), contextId },
      });
      expect(secondAgain).toMatchObject({
        id: second.id,
        status: { state: "TASK_STATE_COMPLETED" },
      });

      const page1 = requiredRecord(
        (await rpc("alice", "ListTasks", { contextId, pageSize: 1 })).result,
        "page",
      );
      expect(page1).toMatchObject({ pageSize: 1, totalSize: 2, tasks: [{ id: second.id }] });
      expect((page1.tasks as Record<string, unknown>[])[0]?.artifacts).toBeUndefined();
      const page2 = requiredRecord(
        (
          await rpc("alice", "ListTasks", {
            contextId,
            includeArtifacts: true,
            pageSize: 1,
            pageToken: page1.nextPageToken,
          })
        ).result,
        "page",
      );
      expect(page2).toMatchObject({
        nextPageToken: "",
        tasks: [{ artifacts: [{}], id: first.id }],
      });
      const foreign = requiredRecord((await rpc("bob", "ListTasks", { contextId })).result, "page");
      expect(foreign).toMatchObject({ tasks: [], totalSize: 0 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "never lets one anonymous caller's messageId reach another's context",
    async () => {
      // none() gives every caller one principal, so the same messageId from two anonymous
      // callers must start two contexts rather than hand the second the first one's task.
      const first = await sendTask("anonymous", { message: userMessage("anon-1", "A2A-ECHO one") });
      const second = await sendTask("anonymous", {
        message: userMessage("anon-1", "A2A-ECHO two"),
      });
      expect(second.contextId).not.toBe(first.contextId);
      expect(second.id).not.toBe(first.id);
      expect(second).toMatchObject({ artifacts: [{ parts: [{ text: "ECHO:A2A-ECHO two" }] }] });
      // Nor does a returnImmediately send, which answers with whatever task the ID resolved to.
      const third = await sendTask("anonymous", {
        configuration: { returnImmediately: true },
        message: userMessage("anon-1", "A2A-ECHO three"),
      });
      expect([first.contextId, second.contextId]).not.toContain(third.contextId);
      expect(JSON.stringify(third)).not.toContain("A2A-ECHO one");

      // Inside a context the caller holds, a retry is still the same task.
      const contextId = requiredString(first.contextId, "contextId");
      const followUp = { ...userMessage("anon-2", "A2A-ECHO three"), contextId };
      const task = await sendTask("anonymous", { message: followUp });
      expect((await sendTask("anonymous", { message: followUp })).id).toBe(task.id);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "returns a new task immediately when asked, before it runs",
    async () => {
      const started = await sendTask("alice", {
        configuration: { historyLength: 0, returnImmediately: true },
        message: userMessage("r-1", "Say hi"),
      });
      expect(["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING", "TASK_STATE_COMPLETED"]).toContain(
        requiredRecord(started.status, "status").state,
      );
      expect(started).not.toHaveProperty("history");
      const streamed = await streamEvents("alice", "SubscribeToTask", { id: started.id }).catch(
        // The task may already be terminal, which SubscribeToTask refuses.
        () => undefined,
      );
      const read = requiredRecord((await rpc("alice", "GetTask", { id: started.id })).result, "t");
      expect(read).toMatchObject({ status: { state: "TASK_STATE_COMPLETED" } });
      // Either way the stream ends on the terminal state: as an update, or as the first snapshot
      // when the task finished between the subscribe check and the first read.
      if (streamed !== undefined) {
        const last = streamed.at(-1) as { statusUpdate?: { status: { state: string } } };
        expect(last.statusUpdate?.status.state ?? taskState(last)).toBe("TASK_STATE_COMPLETED");
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "cancels an interrupted task and reports a failed one",
    async () => {
      const asked = await sendTask("alice", { message: userMessage("c-1", "A2A-ASK") });
      const cancelled = requiredRecord(
        (await rpc("alice", "CancelTask", { id: asked.id })).result,
        "task",
      );
      expect(cancelled).toMatchObject({ id: asked.id, status: { state: "TASK_STATE_CANCELED" } });

      const failed = await sendTask("alice", {
        message: userMessage("f-1", "Trigger A2A-FAILURE-PROBE."),
      });
      expect(failed.status).toMatchObject({ state: "TASK_STATE_FAILED" });
      // Only the error's first line reaches the caller: no upstream page, no stack frames.
      const failure = statusText(failed);
      expect(failure).toContain("A2A-FAILURE-PROBE: provider rejected the request.");
      expect(failure).not.toContain("edge-internal");
      expect(failure).not.toContain("\n");
      expect(JSON.stringify(failed)).not.toMatch(/\n\s+at /);

      // The channel's failureText decides what a failure says.
      const custom = await sendTask("alice", {
        message: userMessage("f-2", "Trigger A2A-CUSTOM-FAILURE."),
      });
      expect(custom.status).toMatchObject({ state: "TASK_STATE_FAILED" });
      expect(statusText(custom)).toMatch(/^Delegation failed \(.+\)\.$/u);
      expect(JSON.stringify(custom)).not.toContain("sk-live-123");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "streams a task to completion, and to input-required then through a subscription",
    async () => {
      // A slow reply, so the first snapshot always precedes completion: a reply that finishes
      // first streams as one terminal task instead, which the spec also allows.
      const quick = await streamEvents("alice", "SendStreamingMessage", {
        message: userMessage("s-1", "A2A-SLOW stream"),
      });
      expect(Object.keys(quick[0] ?? {})).toEqual(["task"]);
      const last = quick.at(-1);
      expect(last).toMatchObject({ statusUpdate: { status: { state: "TASK_STATE_COMPLETED" } } });
      expect(quick).toContainEqual({
        artifactUpdate: expect.objectContaining({
          artifact: expect.objectContaining({
            parts: [expect.objectContaining({ text: "A2A-SLOW-DONE" })],
          }),
          lastChunk: true,
        }),
      });

      const interrupted = await streamEvents("alice", "SendStreamingMessage", {
        message: userMessage("s-2", "A2A-ASK"),
      });
      const paused = interrupted.at(-1) as { statusUpdate?: { status: Record<string, unknown> } };
      expect(paused.statusUpdate?.status.state ?? taskState(interrupted.at(-1))).toBe(
        "TASK_STATE_INPUT_REQUIRED",
      );
      const first = requiredRecord(interrupted[0]?.task, "task");

      const subscription = streamEvents("alice", "SubscribeToTask", { id: first.id });
      // Let the subscription open before the answer lands; it must report the change either way.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await sendTask("alice", {
        message: {
          ...userMessage("s-3", "Yes"),
          contextId: first.contextId,
          taskId: first.id,
        },
      });
      const followed = await subscription;
      expect(Object.keys(followed[0] ?? {})).toEqual(["task"]);
      expect(followed.at(-1)).toMatchObject({
        statusUpdate: { status: { state: "TASK_STATE_COMPLETED" }, taskId: first.id },
      });

      expect(rpcErrorCode(await rpc("alice", "SubscribeToTask", { id: first.id }))).toBe(-32004);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "runs one task at a time in a context, refusing a new one until the last finishes",
    async () => {
      const asked = await sendTask("alice", { message: userMessage("q-1", "A2A-ASK") });
      expect(asked.status).toMatchObject({ state: "TASK_STATE_INPUT_REQUIRED" });
      const contextId = requiredString(asked.contextId, "contextId");
      const newTask = (messageId: string, text: string) =>
        rpc("alice", "SendMessage", {
          configuration: { returnImmediately: true },
          message: { ...userMessage(messageId, text), contextId },
        });

      // While a task waits on its person, a new one is refused rather than answering or
      // steering it, and the waiting task is untouched.
      expect(rpcErrorCode(await newTask("q-2", "A2A-ECHO too soon"))).toBe(-32004);
      expect(await readTask("alice", asked.id)).toMatchObject({
        status: { state: "TASK_STATE_INPUT_REQUIRED" },
      });
      // A retry of a message that already arrived is still its task.
      const retried = await sendTask("alice", {
        configuration: { returnImmediately: true },
        message: { ...userMessage("q-1", "A2A-ASK"), contextId },
      });
      expect(retried.id).toBe(asked.id);

      await sendTask("alice", {
        message: { ...userMessage("q-3", "Yes"), contextId, taskId: asked.id },
      });

      // A working task blocks a new one too; once it finishes, the next one runs.
      const slow = taskOf(await newTask("q-4", "A2A-SLOW"));
      expect(rpcErrorCode(await newTask("q-5", "A2A-ECHO still too soon"))).toBe(-32004);
      expect(await waitForTerminal("alice", slow.id)).toMatchObject({
        status: { state: "TASK_STATE_COMPLETED" },
      });
      const next = await sendTask("alice", {
        message: { ...userMessage("q-6", "A2A-ECHO next"), contextId },
      });
      expect(next).toMatchObject({
        artifacts: [{ parts: [{ text: "ECHO:A2A-ECHO next" }] }],
        status: { state: "TASK_STATE_COMPLETED" },
      });
      const listed = requiredRecord((await rpc("alice", "ListTasks", { contextId })).result, "p");
      expect(listed).toMatchObject({ totalSize: 3 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "steers a working task with a follow-up on its taskId",
    async () => {
      const slow = await sendTask("alice", {
        configuration: { returnImmediately: true },
        message: userMessage("w-1", "A2A-SLOW-LONG"),
      });
      await waitForState("alice", slow.id, "TASK_STATE_WORKING");
      const steered = await sendTask("alice", {
        message: {
          ...userMessage("w-2", "A2A-ECHO steer"),
          contextId: slow.contextId,
          taskId: slow.id,
        },
      });
      expect(steered).toMatchObject({ id: slow.id, status: { state: "TASK_STATE_COMPLETED" } });
      const read = await readTask("alice", slow.id);
      expect((read.history as { messageId: string }[]).map((m) => m.messageId)).toEqual([
        "w-1",
        "w-2",
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses an answer that matches none of an approval's options",
    async () => {
      const asked = await sendTask("alice", { message: userMessage("a-1", "A2A-APPROVE") });
      expect(asked.status).toMatchObject({ state: "TASK_STATE_INPUT_REQUIRED" });
      const promptText = JSON.stringify(asked.status);
      expect(promptText).toContain("Approve");

      const refused = await rpc("alice", "SendMessage", {
        message: {
          ...userMessage("a-2", "maybe later"),
          contextId: asked.contextId,
          taskId: asked.id,
        },
      });
      expect(rpcErrorCode(refused)).toBe(-32602);
      expect(await readTask("alice", asked.id)).toMatchObject({
        status: { state: "TASK_STATE_INPUT_REQUIRED" },
      });

      const approved = await sendTask("alice", {
        message: { ...userMessage("a-3", "approve"), contextId: asked.contextId, taskId: asked.id },
      });
      expect(approved).toMatchObject({
        artifacts: [{ parts: [{ text: "A2A-APPROVED" }] }],
        id: asked.id,
        status: { state: "TASK_STATE_COMPLETED" },
      });
    },
    TEST_TIMEOUT_MS,
  );
});

async function readTask(principal: string, id: unknown): Promise<Record<string, unknown>> {
  const envelope = await rpc(principal, "GetTask", { id });
  if (envelope.error !== undefined) throw new Error(JSON.stringify(envelope.error));
  return requiredRecord(envelope.result, "task");
}

async function waitForState(
  principal: string,
  id: unknown,
  state: string,
): Promise<Record<string, unknown>> {
  return await waitForTask(principal, id, (task) => taskStateOf(task) === state);
}

async function waitForTerminal(principal: string, id: unknown): Promise<Record<string, unknown>> {
  const terminal = ["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED"];
  return await waitForTask(principal, id, (task) => terminal.includes(String(taskStateOf(task))));
}

async function waitForTask(
  principal: string,
  id: unknown,
  done: (task: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  for (;;) {
    const task = await readTask(principal, id);
    if (done(task)) return task;
    if (Date.now() > deadline)
      throw new Error(`Task never reached the state: ${JSON.stringify(task)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function taskStateOf(task: Record<string, unknown>): unknown {
  return (task.status as { state?: unknown } | undefined)?.state;
}

function userMessage(messageId: string, text: string) {
  return { messageId, parts: [{ text }], role: "ROLE_USER" };
}

interface RpcResult extends Record<string, unknown> {
  readonly headers: Headers;
}

async function rpc(
  principal: string,
  method: string,
  params: Readonly<Record<string, unknown>>,
  options: { readonly version?: string | null } = {},
): Promise<RpcResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-test-principal": principal,
  };
  if (options.version !== null) headers["a2a-version"] = options.version ?? "1.0";
  const response = await fetch(new URL("/eve/v1/a2a", url()), {
    body: JSON.stringify({ id: crypto.randomUUID(), jsonrpc: "2.0", method, params }),
    headers,
    method: "POST",
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`A2A HTTP ${response.status}: ${body}`);
  return { ...requiredRecord(JSON.parse(body), "JSON-RPC envelope"), headers: response.headers };
}

function rpcErrorCode(envelope: Record<string, unknown>): unknown {
  return requiredRecord(envelope.error, "error").code;
}

function statusText(task: Record<string, unknown>): string {
  const message = requiredRecord(requiredRecord(task.status, "status").message, "message");
  return (message.parts as { text?: string }[]).map((part) => part.text ?? "").join("");
}

function taskOf(envelope: Record<string, unknown>): Record<string, unknown> {
  if (envelope.error !== undefined) throw new Error(JSON.stringify(envelope.error));
  return requiredRecord(requiredRecord(envelope.result, "result").task, "task");
}

async function sendTask(
  principal: string,
  params: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  return taskOf(await rpc(principal, "SendMessage", params));
}

function taskState(event: Record<string, unknown> | undefined): unknown {
  const task = event?.task as { status?: { state?: unknown } } | undefined;
  return task?.status?.state;
}

/** Reads an SSE response to its end: one JSON-RPC result per event. */
async function streamEvents(
  principal: string,
  method: string,
  params: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(new URL("/eve/v1/a2a", url()), {
    body: JSON.stringify({ id: 7, jsonrpc: "2.0", method, params }),
    headers: {
      "a2a-version": "1.0",
      "content-type": "application/json",
      "x-test-principal": principal,
    },
    method: "POST",
    signal: AbortSignal.timeout(OPERATION_TIMEOUT_MS),
  });
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const body = await response.text();
  return body
    .split("\n\n")
    .map((event) => event.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => line !== undefined)
    .map((line) => {
      const envelope = requiredRecord(JSON.parse(line.slice("data: ".length)), "event");
      expect(envelope).toMatchObject({ id: 7, jsonrpc: "2.0" });
      if (envelope.error !== undefined) throw new Error(JSON.stringify(envelope.error));
      return requiredRecord(envelope.result, "result");
    });
}
