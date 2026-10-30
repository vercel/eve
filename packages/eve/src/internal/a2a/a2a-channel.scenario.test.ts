import { spawn, type ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  materializeScenarioApp,
  type ScenarioAppDescriptor,
} from "#internal/testing/scenario-app.js";

const SETUP_TIMEOUT_MS = 360_000;
const TEST_TIMEOUT_MS = 60_000;
const OPERATION_TIMEOUT_MS = 30_000;
const A2A_AGENT_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const model = mockModel((request) => {
  const prompt = JSON.stringify(request.messages);
  if (prompt.includes("A2A-FAILURE-PROBE")) {
    throw new Error("A2A-FAILURE-PROBE: provider rejected the request.");
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
import { a2aChannel } from "eve/experimental/channels/a2a";

export default a2aChannel({
  auth: withAuthChallenges((request) => {
    const principalId = request.headers.get("x-test-principal");
    return principalId === null
      ? null
      : { attributes: {}, authenticator: "scenario", principalId, principalType: "user" };
  }, [{ scheme: "Bearer" }]),
  maxBlockingMs: 10_000,
  uploadPolicy: { allowedMediaTypes: ["image/*"] },
});
`,
    "agent/instructions.md": "Follow the deterministic mock-model lifecycle.\n",
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
    server = await startEveDev(app.appRoot);
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
    "refuses unauthenticated calls, other versions, and unsupported features",
    async () => {
      const anonymous = await fetch(new URL("/eve/v1/a2a", url()), {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "GetTask", params: { id: "x" } }),
        headers: { "a2a-version": "1.0", "content-type": "application/json" },
        method: "POST",
      });
      expect(anonymous.status).toBe(401);

      // An absent version means 0.3.
      const legacy = await rpc("alice", "GetTask", { id: "x" }, { version: null });
      expect(rpcErrorCode(legacy)).toBe(-32009);
      expect(rpcErrorCode(await rpc("alice", "GetTask", { id: "x" }, { version: "2.0" }))).toBe(
        -32009,
      );

      expect(rpcErrorCode(await rpc("alice", "GetTask", { id: "not-a-task" }))).toBe(-32001);
      expect(rpcErrorCode(await rpc("alice", "message/send", {}))).toBe(-32601);
      expect(rpcErrorCode(await rpc("alice", "GetExtendedAgentCard", {}))).toBe(-32004);
      expect(
        rpcErrorCode(await rpc("alice", "CreateTaskPushNotificationConfig", { taskId: "x" })),
      ).toBe(-32003);
      expect(rpcErrorCode(await rpc("alice", "SendMessage", { message: { parts: [] } }))).toBe(
        -32602,
      );
      expect(rpcErrorCode(await rpc("alice", "ListTasks", { contextId: "x", pageSize: 500 }))).toBe(
        -32602,
      );
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
      expect(JSON.stringify(failed)).not.toMatch(/\n\s+at /);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "streams a task to completion, and to input-required then through a subscription",
    async () => {
      const quick = await streamEvents("alice", "SendStreamingMessage", {
        message: userMessage("s-1", "Say hi"),
      });
      expect(Object.keys(quick[0] ?? {})).toEqual(["task"]);
      const last = quick.at(-1);
      expect(last).toMatchObject({ statusUpdate: { status: { state: "TASK_STATE_COMPLETED" } } });
      expect(quick).toContainEqual({
        artifactUpdate: expect.objectContaining({
          artifact: expect.objectContaining({
            parts: [expect.objectContaining({ text: "A2A-QUICK-REPLY" })],
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
});

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

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} was not an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} was not a non-empty string.`);
  }
  return value;
}

interface RunningEveDev {
  readonly stderr: () => string;
  readonly stdout: () => string;
  readonly url: string;
  stop(): Promise<void>;
}

async function startEveDev(appRoot: string): Promise<RunningEveDev> {
  const eveBinPath = join(appRoot, "node_modules", "eve", "bin", "eve.js");
  const child = spawn(
    process.execPath,
    [eveBinPath, "dev", "--no-ui", "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: appRoot,
      env: { ...process.env, EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let url: string;
  try {
    url = await waitForServerUrl(child, () => ({ stderr, stdout }));
  } catch (error) {
    await stopChild(child);
    throw error;
  }
  return {
    stderr: () => stderr,
    stdout: () => stdout,
    async stop() {
      await stopChild(child);
    },
    url,
  };
}

async function waitForServerUrl(
  child: ChildProcessByStdio<null, Readable, Readable>,
  output: () => { readonly stderr: string; readonly stdout: string },
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      const current = output();
      reject(new Error(`Timed out waiting for eve dev.\n${current.stdout}\n${current.stderr}`));
    }, OPERATION_TIMEOUT_MS);
    function inspect() {
      const url = /\[DEV\] server listening at (http:\/\/[^\s]+)/u.exec(output().stdout)?.[1];
      if (url !== undefined) {
        cleanup();
        resolve(url);
      }
    }
    function exited(code: number | null, signal: NodeJS.Signals | null) {
      cleanup();
      const current = output();
      reject(
        new Error(
          `eve dev exited before startup (code ${String(code)}, ${String(signal)}).\n${current.stdout}\n${current.stderr}`,
        ),
      );
    }
    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off("data", inspect);
      child.stderr.off("data", inspect);
      child.off("exit", exited);
    }
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", exited);
    inspect();
  });
}

async function stopChild(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
