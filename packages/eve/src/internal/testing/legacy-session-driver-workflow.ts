import { createHook, getWorkflowMetadata, getWritable } from "#compiled/@workflow/core/index.js";
import { start } from "#internal/workflow/runtime.js";
import { turnWorkflow } from "#execution/legacy-session/turn-workflow.js";
import type { DurableSession } from "#execution/durable-session-store.js";

/** Frozen driver-side protocol: it cannot see the current session inbox. */
export async function legacySessionDriverWorkflow(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly alias: string;
  readonly inputVersion?: 1 | 2;
  /** `undefined` models a driver older than eve 0.45 that stamped no wire version. */
  readonly inboxVersion?: number;
  readonly committedInput?: boolean;
  readonly duplicateImport?: boolean;
  readonly sessionTimeoutMs?: number | false;
}): Promise<unknown> {
  "use workflow";
  const { workflowRunId: sessionId } = getWorkflowMetadata();
  const metadata =
    input.inboxVersion === undefined ? {} : { sessionInboxWireVersion: input.inboxVersion };
  const command = createHook<{ kind: string; payload?: unknown; payloads?: unknown[] }>({
    token: `eve:session:${sessionId}:inbox`,
    metadata,
  });
  const alias = input.alias === "" ? undefined : createHook({ token: input.alias, metadata });
  const completion = createHook<{ action: { kind: string; output: unknown } }>({
    token: `${sessionId}:turn-control:0`,
  });
  const parentWritable = getWritable<Uint8Array>();
  try {
    const delivery = await command;
    const session: DurableSession = {
      sessionId,
      continuationToken: input.alias,
      agent: { system: "previous deployment" },
      history: [
        { role: "user", kind: "user", content: "Alice selected blue for the project." },
        { role: "assistant", content: "The project color is blue." },
        ...(input.committedInput
          ? [
              {
                role: "user" as const,
                kind: "user" as const,
                content: "Alice asks to continue the blue project.",
              },
            ]
          : []),
      ],
      state: {
        "app.color": "blue",
        "eve.harness.emission": {
          sessionStarted: true,
          sequence: 7,
          stepIndex: 0,
          turnId: input.committedInput ? "turn_7" : "",
        },
      },
    };
    const sessionState = {
      version: 1,
      sessionId,
      continuationToken: input.alias,
      hasProxyInputRequests: false,
      emissionState: session.state!["eve.harness.emission"],
      snapshot: { version: 1, session },
    };
    const turnInput = {
      version: input.inputVersion ?? 2,
      mode: "conversation",
      completionToken: completion.token,
      stepInput: {
        input: { ...delivery, kind: "deliver", payloads: delivery.payloads ?? [delivery.payload] },
        parentWritable,
        sessionState,
        serializedContext: {
          ...input.serializedContext,
          "eve.sessionId": sessionId,
          "eve.continuationToken": input.alias,
        },
      },
    };
    const rawInput = input.committedInput
      ? {
          ...turnInput,
          initialStep: {
            beforeStep: turnInput.stepInput,
            result: { sessionState, serializedContext: turnInput.stepInput.serializedContext },
          },
        }
      : turnInput;
    await dispatchLegacyTurnStep(rawInput);
    if (input.duplicateImport) await dispatchLegacyTurnStep(rawInput);
    return (await completion).action;
  } finally {
    await command.dispose();
    await alias?.dispose();
    await completion.dispose();
  }
}
async function dispatchLegacyTurnStep(input: unknown): Promise<void> {
  "use step";
  await start(turnWorkflow, [input], { deploymentId: "latest" });
}
