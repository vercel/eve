import { createHook, getWorkflowMetadata, sleep } from "#compiled/@workflow/core/index.js";
import {
  a2aOperationStep,
  a2aResultStep,
  type A2AOperationResult,
} from "#execution/a2a-agent-step.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import { readWorkflowAuthorizationCallback } from "#execution/tools/workflow/step.js";
import { disposeHook } from "#execution/hook-ownership.js";
import {
  createAuthorizationRequiredEvent,
  createAuthorizationCompletedEvent,
} from "#protocol/message.js";
import type { WorkflowStepAuthorizationResult } from "#execution/tools/workflow/step-context.js";
import type { A2AEndpoint } from "#runtime/a2a/client.js";
import {
  a2aControlToken,
  type A2AWorkflowInput,
  type A2ACommand,
  type A2AOperation,
} from "#runtime/a2a/types.js";
import type { JsonValue } from "#shared/json.js";

const usageDelta = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Durable transport adapter; A2A tasks never enter the agent execution kernel. */
export async function a2aAgentWorkflow(input: A2AWorkflowInput): Promise<void> {
  "use workflow";
  const runId = getWorkflowMetadata().workflowRunId;
  const commands = createHook<A2ACommand>({ token: a2aControlToken(runId) });
  const iterator = commands[Symbol.asyncIterator]();
  let command = iterator.next();
  let invocation = input.invocation;
  let endpoint: A2AEndpoint | undefined;
  let taskId: string | undefined;
  let contextId: string | undefined;
  let canceled = false;
  let awaitingRemoteAuthorization = false;

  const nextCommand = async () => {
    const next = await command;
    command = iterator.next();
    if (next.done || next.value.kind === "cancel") {
      canceled = true;
      return undefined;
    }
    invocation = {
      ...next.value.invocation,
      outputSchema: next.value.invocation.outputSchema ?? invocation.outputSchema,
      session: {
        ...invocation.session,
        auth: { ...invocation.session.auth, current: next.value.auth },
      },
    };
    return invocation;
  };
  const operation = async (
    method: A2AOperation["method"],
    params: A2AOperation["params"],
    allowAuthorization = true,
  ): Promise<A2AOperationResult> => {
    const callbacks = createHook<unknown>();
    const authorizationResults: WorkflowStepAuthorizationResult[] = [];
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await a2aOperationStep(
          { definition: input, endpoint, method, params },
          {
            callId: invocation.callId,
            toolName: input.name,
            session: invocation.session,
            baseUrl: input.callbackBaseUrl,
            token: callbacks.token,
            authorizationResults,
          },
        );
        if (result.kind === "result") {
          for (const challenge of authorizationResults) {
            await resumeHookStep(invocation.replyToken, {
              kind: "subagent-authorization-event",
              callId: invocation.callId,
              childSessionId: runId,
              subagentName: input.name,
              event: createAuthorizationCompletedEvent({
                attemptId: challenge.attemptId,
                name: challenge.name,
                sequence: invocation.session.turn.sequence,
                stepIndex: 0,
                turnId: invocation.session.turn.id,
                outcome: "authorized",
              }),
            });
          }
          const value = result.output as A2AOperationResult;
          endpoint = value.endpoint;
          return value;
        }
        if (!allowAuthorization) throw new Error("Cancellation requires renewed authorization.");
        for (const challenge of result.signal.challenges) {
          if (challenge.attemptId === undefined)
            throw new Error("A2A authorization has no attempt id.");
          await resumeHookStep(invocation.replyToken, {
            kind: "subagent-authorization-event",
            callId: invocation.callId,
            childSessionId: runId,
            subagentName: input.name,
            event: createAuthorizationRequiredEvent({
              attemptId: challenge.attemptId,
              name: challenge.name,
              authorization: challenge.challenge,
              description: `Sign in to ${input.name} to continue.`,
              webhookUrl: challenge.hookUrl,
              sequence: invocation.session.turn.sequence,
              stepIndex: 0,
              turnId: invocation.session.turn.id,
            }),
          });
          const callbackIterator = callbacks[Symbol.asyncIterator]();
          for (;;) {
            const next = await Promise.race([
              callbackIterator.next().then((value) => ({ kind: "callback" as const, value })),
              command.then(() => ({ kind: "command" as const })),
            ]);
            if (next.kind === "command") {
              await nextCommand();
              throw new Error("A2A authorization interrupted.");
            }
            if (next.value.done) throw new Error("A2A authorization callback closed.");
            const callback = readWorkflowAuthorizationCallback(next.value.value, {
              ...challenge,
              attemptId: challenge.attemptId,
            });
            if (callback === undefined) continue;
            authorizationResults.push({ ...challenge, attemptId: challenge.attemptId, callback });
            break;
          }
        }
      }
      throw new Error("A2A authorization did not complete.");
    } finally {
      await disposeHook(callbacks);
    }
  };
  const report = async (output: JsonValue, failed = false, terminal = false) => {
    await resumeHookStep(
      invocation.replyToken,
      {
        kind: "runtime-action-result",
        results: [
          {
            callId: invocation.callId,
            kind: "subagent-result",
            origin: "child",
            subagentName: input.name,
            isError: failed || undefined,
            output,
            outcome: {
              kind: terminal ? "terminal" : "parked",
              usageDelta,
              result: failed ? { kind: "failed", error: output } : { kind: "succeeded", output },
            },
          },
        ],
      },
      { ifPresent: true },
    );
  };
  try {
    for (;;) {
      const message: Record<string, JsonValue> = {
        messageId: crypto.randomUUID(),
        role: "ROLE_USER",
        parts: [{ text: invocation.message }],
      };
      if (taskId !== undefined) message.taskId = taskId;
      if (contextId !== undefined) message.contextId = contextId;
      const sent: A2AOperationResult =
        awaitingRemoteAuthorization && taskId !== undefined
          ? await operation("GetTask", { id: taskId, historyLength: 0 })
          : await operation("SendMessage", {
              message,
              configuration: {
                returnImmediately: true,
                acceptedOutputModes: [
                  invocation.outputSchema === undefined ? "text/plain" : "application/json",
                ],
                historyLength: 0,
              },
            });
      awaitingRemoteAuthorization = false;
      let response: A2AOperationResult["response"] = sent.response;
      if ("message" in response) {
        contextId = response.message.contextId;
      } else {
        taskId = response.task.id;
        contextId = response.task.contextId;
        let backoff = 500;
        while (
          response.task.status.state === "TASK_STATE_SUBMITTED" ||
          response.task.status.state === "TASK_STATE_WORKING"
        ) {
          const next = await Promise.race([
            command.then(() => "command" as const),
            sleep(backoff).then(() => "poll" as const),
          ]);
          if (next === "command") {
            await nextCommand();
            if (canceled) return;
          }
          const polled = await operation("GetTask", { id: response.task.id, historyLength: 0 });
          if (!("task" in polled.response)) throw new Error("A2A polling returned a message.");
          response = polled.response;
          backoff = Math.min(backoff * 2, 5000);
        }
      }
      if (
        "task" in response &&
        (response.task.status.state === "TASK_STATE_INPUT_REQUIRED" ||
          response.task.status.state === "TASK_STATE_AUTH_REQUIRED")
      ) {
        awaitingRemoteAuthorization = response.task.status.state === "TASK_STATE_AUTH_REQUIRED";
        await report({
          status: awaitingRemoteAuthorization ? "authorization_required" : "input_required",
          message:
            response.task.status.message?.parts
              .map((part) => part.text ?? "")
              .filter(Boolean)
              .join("\n") ?? "The remote agent needs more information.",
        });
      } else if ("task" in response && response.task.status.state !== "TASK_STATE_COMPLETED") {
        await report(
          { code: response.task.status.state, message: "The remote A2A task did not complete." },
          true,
          true,
        );
        return;
      } else {
        taskId = undefined;
        await report(await a2aResultStep(response, invocation.outputSchema));
      }
      if ((await nextCommand()) === undefined) return;
    }
  } catch (error) {
    if (!canceled)
      await report(
        {
          code: "A2A_FAILED",
          message:
            error instanceof Error && error.name === "A2AError"
              ? error.message
              : "The A2A subagent could not complete the request.",
        },
        true,
        true,
      );
  } finally {
    if (taskId !== undefined && endpoint !== undefined) {
      try {
        await operation("CancelTask", { id: taskId }, false);
      } catch {
        /* Best-effort remote cancellation. */
      }
    }
    await disposeHook(commands);
  }
}
