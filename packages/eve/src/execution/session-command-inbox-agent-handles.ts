import { getWritable } from "#compiled/@workflow/core/index.js";

import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import type {
  AgentHandleCommandRequest,
  AgentHandleCommandResponse,
} from "#execution/session-command-inbox.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import {
  EMPTY_AGENT_HANDLE_STORE,
  getAgentHandleStore,
  setAgentHandleStore,
  type AgentHandleStore,
  type AgentHandleStoreCommand,
} from "#harness/handles/store.js";
import { applyAgentHandleStoreCommand } from "#harness/handles/transitions.js";
import { getRun, resumeHook } from "#internal/workflow/runtime.js";

const AGENT_HANDLE_COMMAND_RESPONSE_STREAM_NAMESPACE = "eve.agent-handle-command-responses";
const AGENT_HANDLE_COMMAND_READ_TIMEOUT_MS = 10_000;

/** Applies one driver-serialized mutation to the canonical session-state handle store. */
export async function applyAgentHandleCommandStep(input: {
  readonly request: AgentHandleCommandRequest;
  readonly sessionState: DurableSessionState;
}): Promise<{ readonly sessionState: DurableSessionState }> {
  "use step";

  const session = await readDurableSession(input.sessionState);
  const store = getAgentHandleStore(session.state) ?? EMPTY_AGENT_HANDLE_STORE;
  const applied = applyAgentHandleStoreCommand(store, input.request.command);
  const sessionState =
    applied.store === store
      ? input.sessionState
      : replaceDurableSessionSnapshot({
          session: {
            ...session,
            state: setAgentHandleStore(session.state, applied.store),
          },
          state: input.sessionState,
        });
  await publishResponse({
    commandId: input.request.commandId,
    result: applied.result,
    store: applied.store,
  });
  return { sessionState };
}

/** Reads the canonical agent handle store through its session driver. */
export async function readAgentHandleStoreStep(input: {
  readonly sessionId: string;
}): Promise<AgentHandleStore> {
  "use step";

  const response = await sendCommand({
    command: { kind: "read" },
    commandId: `read:${crypto.randomUUID()}`,
    kind: "agent-handle-command",
    sessionId: input.sessionId,
  });
  return response.store;
}

/** Sends one serialized mutation to the session driver's canonical handle store. */
export async function sendAgentHandleCommandStep(input: {
  readonly command: AgentHandleStoreCommand;
  readonly commandId: string;
  readonly sessionId: string;
}): Promise<AgentHandleCommandResponse> {
  "use step";

  return await sendCommand({ ...input, kind: "agent-handle-command" });
}

async function publishResponse(response: AgentHandleCommandResponse): Promise<void> {
  const writer = getWritable<AgentHandleCommandResponse>({
    namespace: AGENT_HANDLE_COMMAND_RESPONSE_STREAM_NAMESPACE,
  }).getWriter();
  try {
    await writer.write(response);
  } finally {
    writer.releaseLock();
  }
}

async function sendCommand(
  request: AgentHandleCommandRequest & { readonly sessionId: string },
): Promise<AgentHandleCommandResponse> {
  const run = getRun(request.sessionId);
  const before = run.getReadable<AgentHandleCommandResponse>({
    namespace: AGENT_HANDLE_COMMAND_RESPONSE_STREAM_NAMESPACE,
  });
  const tail = await before.getTailIndex();
  await before.cancel("eve agent handle command response tail resolved").catch(() => {});

  await resumeHook(sessionCommandHookToken(request.sessionId), {
    command: request.command,
    commandId: request.commandId,
    kind: request.kind,
  });

  const stream = run.getReadable<AgentHandleCommandResponse>({
    namespace: AGENT_HANDLE_COMMAND_RESPONSE_STREAM_NAMESPACE,
    startIndex: tail + 1,
  });
  const reader = stream.getReader();
  try {
    while (true) {
      const response = await readResponse(reader, `agent handle command ${request.commandId}`);
      if (response.commandId === request.commandId) return response;
    }
  } finally {
    await reader.cancel("eve agent handle command resolved").catch(() => {});
    reader.releaseLock();
  }
}

async function readResponse(
  reader: ReadableStreamDefaultReader<AgentHandleCommandResponse>,
  what: string,
): Promise<AgentHandleCommandResponse> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      reader.read().then((read) => ({ kind: "read" as const, read })),
      new Promise<{ readonly kind: "timeout" }>((resolve) => {
        timeout = setTimeout(
          () => resolve({ kind: "timeout" }),
          AGENT_HANDLE_COMMAND_READ_TIMEOUT_MS,
        );
      }),
    ]);
    if (result.kind === "timeout") {
      throw new Error(`Timed out reading ${what} after ${AGENT_HANDLE_COMMAND_READ_TIMEOUT_MS}ms.`);
    }
    if (result.read.done || result.read.value === undefined) {
      throw new Error(`No response found while reading ${what}.`);
    }
    return result.read.value;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
