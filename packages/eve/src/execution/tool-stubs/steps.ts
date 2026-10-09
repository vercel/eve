import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { getWritable } from "#compiled/@workflow/core/index.js";
import { getRun, resumeHook } from "#internal/workflow/runtime.js";
import type { StubRequest } from "#execution/tool-stubs/playback.js";
import {
  STUB_FAILURE_NAMESPACE,
  STUB_MATCHES_NAMESPACE,
  stubResponseNamespace,
  type StubCall,
  type StubResult,
  type StubScope,
} from "#tool-stubs/types.js";

export async function publishStubResultStep(input: {
  readonly callId: string;
  readonly result: StubResult;
  readonly matchedRuleId?: string;
}): Promise<void> {
  "use step";
  if (input.matchedRuleId !== undefined) {
    const writer = getWritable<string>({ namespace: STUB_MATCHES_NAMESPACE }).getWriter();
    try {
      await writer.write(input.matchedRuleId);
    } finally {
      writer.releaseLock();
    }
  }
  const writer = getWritable<StubResult>({
    namespace: stubResponseNamespace(input.callId),
  }).getWriter();
  try {
    await writer.write(input.result);
  } finally {
    writer.releaseLock();
  }
}

export async function publishStubFailureStep(error: string): Promise<void> {
  "use step";
  const writer = getWritable<string>({ namespace: STUB_FAILURE_NAMESPACE }).getWriter();
  try {
    await writer.write(error);
  } finally {
    writer.releaseLock();
  }
}

/**
 * Ordinary tools call this inside their existing step.
 * Workflow tools use this function as a separate step.
 */
export async function callToolStubStep(scope: StubScope, call: StubCall): Promise<StubResult> {
  "use step";
  return await requestStub(scope, { kind: "call", call });
}

export async function reportStubFailureStep(
  scope: StubScope,
  callId: string,
  error: string,
): Promise<void> {
  "use step";
  try {
    await requestStub(scope, { kind: "failure", callId, error });
  } catch (cause) {
    // Without an acknowledgement, verification cannot safely declare this eval successful.
    // Cancel the stub-owning run so the caller can keep its original output error or fallback.
    if (scope.rootSessionId === undefined) throw cause;
    await getRun(scope.rootSessionId).cancel({
      cancelReason: "Could not record a tool stub output-processing failure.",
    });
  }
}

async function requestStub(scope: StubScope, request: StubRequest): Promise<StubResult> {
  const root = scope.rootSessionId;
  if (root === undefined)
    throw new Error("Tool stub session is missing its durable playback owner.");
  const callId = request.kind === "call" ? request.call.callId : `${request.callId}:failure`;
  await resumeHook(scope.token, request);
  const reader = getRun(root)
    .getReadable<StubResult>({ namespace: stubResponseNamespace(callId) })
    .getReader();
  try {
    const { done, value } = await reader.read();
    if (done) throw new Error("Tool stub session ended without a response.");
    return value;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function readStubFailure(sessionId: string): Promise<string | undefined> {
  const run = getRun(sessionId);
  const stream = run.getReadable<string>({ namespace: STUB_FAILURE_NAMESPACE });
  if ((await stream.getTailIndex()) < 0) {
    await stream.cancel();
    const status = await run.status;
    return status === "failed" || status === "cancelled"
      ? "Tool stub session failed before verification."
      : undefined;
  }
  const reader = stream.getReader();
  try {
    return (await reader.read()).value;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** Use the session's inbox so failures reach it after a newer deployment takes over. */
export async function failStubSessionStep(sessionId: string): Promise<void> {
  "use step";
  await resumeSessionInbox(
    { sessionId },
    { kind: "session-failure", error: "Tool stub playback failed." },
  );
}

/** Read completed matches without waiting for the still-running session to finish. */
export async function readMatchedStubRules(sessionId: string): Promise<readonly string[]> {
  const stream = getRun(sessionId).getReadable<string>({ namespace: STUB_MATCHES_NAMESPACE });
  const tail = await stream.getTailIndex();
  const reader = stream.getReader();
  const ids = new Set<string>();
  try {
    for (let index = 0; index <= tail; index++) {
      const { done, value } = await reader.read();
      if (done) throw new Error("Tool stub match records ended unexpectedly.");
      ids.add(value);
    }
    return [...ids];
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
