import type { McpJsonObject } from "#compiled/@modelcontextprotocol/server/index.js";
import type { z } from "#compiled/zod/index.js";

import type {
  AgentInvocation,
  AgentInvocationInteraction,
} from "#internal/invocation/agent-invocation.js";
import type { WorkflowAgentInvocationExecution } from "#internal/invocation/workflow-execution.js";
import { McpProtocolError, type McpCallToolResult } from "#internal/mcp/streamable-http-server.js";
import type { McpTask, McpTaskSource } from "#internal/mcp/tasks.js";
import type { Answer } from "#shared/input.js";
import { parseJsonObject } from "#shared/json.js";

type SignIn = NonNullable<AgentInvocationInteraction["request"]["signIn"]>;

/**
 * Serves agent invocations as MCP tasks. A task is the invocation under its
 * own ID; a completed task's result is what `agent_get` returns for it.
 */
export function createInvocationTaskSource(
  execution: WorkflowAgentInvocationExecution,
  options: {
    /** The tool that starts invocations, and the arguments it accepts. */
    readonly startTool: {
      readonly inputSchema: z.ZodType<{ readonly message: string }>;
      readonly name: string;
    };
    readonly toolResult: (invocation: AgentInvocation) => McpCallToolResult;
  },
): McpTaskSource {
  const task = (invocation: AgentInvocation) => invocationTask(invocation, options.toolResult);
  return {
    async start(auth, call) {
      if (call.name !== options.startTool.name) return undefined;
      const checked = options.startTool.inputSchema.safeParse(call.arguments);
      // The tool itself answers invalid arguments with its usual `invalid_input` result.
      if (!checked.success) return undefined;
      return task(await execution.create({ auth, message: checked.data.message }));
    },
    async cancel(auth, taskId) {
      const invocation = await execution.cancel({ auth, invocationId: taskId });
      return invocation === undefined ? "not_found" : "cancelled";
    },
    async get(auth, taskId) {
      const invocation = await execution.read({ auth, invocationId: taskId });
      return invocation === undefined ? undefined : task(invocation);
    },
    async update(auth, taskId, inputResponses) {
      const result = await execution.update({
        auth,
        invocationId: taskId,
        responses: Object.entries(inputResponses).map(([interactionId, response]) =>
          answer(interactionId, response),
        ),
      });
      if (result.type === "conflict") throw new McpProtocolError(-32602, result.message);
      return result.type === "not_found" ? "not_found" : "updated";
    },
    async *watch(auth, taskId, signal) {
      for await (const invocation of execution.watch({ auth, invocationId: taskId, signal })) {
        yield task(invocation);
      }
    },
  };
}

/** The invocation as the Tasks extension's `DetailedTask`. */
export function invocationTask(
  invocation: AgentInvocation,
  toolResult: (invocation: AgentInvocation) => McpCallToolResult,
): McpTask {
  const task = {
    createdAt: invocation.createdAt,
    lastUpdatedAt: invocation.updatedAt,
    taskId: invocation.invocationId,
    ttlMs:
      invocation.expiresAt === undefined
        ? null
        : Math.max(0, Date.parse(invocation.expiresAt) - Date.parse(invocation.createdAt)),
  };
  switch (invocation.status) {
    case "working":
      return {
        ...task,
        pollIntervalMs: invocation.pollAfterMs,
        status: "working",
        ...(invocation.statusMessage === undefined
          ? {}
          : { statusMessage: invocation.statusMessage }),
      };
    case "awaiting-input": {
      const open = Object.entries(invocation.interactions);
      const questions = open.filter(([, asked]) => asked.request.signIn === undefined);
      const signIns = open.flatMap(([, asked]) =>
        asked.request.signIn === undefined ? [] : [signInMessage(asked.request.signIn)],
      );
      const signInStatus = signIns.length === 0 ? {} : { statusMessage: signIns.join(" ") };
      // Sign-ins happen out of band, at their URL; a task waiting only on them is still working.
      if (questions.length === 0) {
        return {
          ...task,
          pollIntervalMs: invocation.pollAfterMs ?? 1_000,
          status: "working",
          ...signInStatus,
        };
      }
      return {
        ...task,
        inputRequests: Object.fromEntries(
          questions.map(([key, asked]) => [key, elicitation(asked.request)]),
        ),
        status: "input_required",
        ...signInStatus,
      };
    }
    case "completed":
      return { ...task, result: parseJsonObject(toolResult(invocation)), status: "completed" };
    case "failed":
      return {
        ...task,
        error: parseJsonObject(invocation.error),
        status: "failed",
        statusMessage: invocation.error.message,
      };
    case "cancelled":
      return { ...task, status: "cancelled" };
  }
}

function signInMessage(challenge: SignIn): string {
  const name = challenge.displayName ?? challenge.name;
  const steps = [
    challenge.url === undefined ? undefined : `open ${challenge.url}`,
    challenge.userCode === undefined ? undefined : `enter code ${challenge.userCode}`,
    challenge.instructions,
  ].filter((step) => step !== undefined);
  return steps.length === 0
    ? `Waiting for ${name} sign-in.`
    : `Waiting for ${name} sign-in: ${steps.join(", ")}.`;
}

/**
 * An eve question as a form elicitation: pick one of its options as
 * `answer`, or type `text` when it takes freeform answers.
 */
function elicitation(request: AgentInvocationInteraction["request"]): McpJsonObject {
  const options = request.options ?? [];
  const properties: Record<string, McpJsonObject> = {};
  if (options.length > 0) {
    properties.answer = {
      oneOf: options.map((option) => ({ const: option.id, title: option.label })),
      title: "Answer",
      type: "string",
    };
  }
  if (options.length === 0 || request.allowFreeform === true) {
    properties.text = { title: options.length === 0 ? "Answer" : "Other", type: "string" };
  }
  const required = options.length === 0 ? ["text"] : request.allowFreeform ? [] : ["answer"];
  return {
    method: "elicitation/create",
    params: {
      message: request.prompt,
      mode: "form",
      requestedSchema: { properties, required, type: "object" },
    },
  };
}

function answer(interactionId: string, response: unknown): Answer {
  const content =
    isRecord(response) && response.action === "accept" && isRecord(response.content)
      ? response.content
      : undefined;
  const optionId = typeof content?.answer === "string" ? content.answer : undefined;
  const text = typeof content?.text === "string" ? content.text : undefined;
  if (optionId === undefined && text === undefined) {
    throw new McpProtocolError(
      -32602,
      `Input ${interactionId} needs an accepted answer; to stop the task, call tasks/cancel instead.`,
    );
  }
  return {
    interactionId,
    ...(optionId === undefined ? {} : { optionId }),
    ...(text === undefined ? {} : { text }),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
