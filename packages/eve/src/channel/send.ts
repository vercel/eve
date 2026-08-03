import type { FilePart, UserContent } from "ai";

import type { ChannelAdapter } from "#channel/adapter.js";
import type { RunInput, Runtime, SessionCommand } from "#channel/types.js";
import { createSession, type Session } from "#channel/session.js";
import type { SendFn, SendOptions, SendPayload } from "#channel/routes.js";
import {
  isRuntimeSessionOwnershipConflictError,
  RuntimeNoActiveSessionError,
} from "#execution/runtime-errors.js";
import { serializeUrlFilePart } from "#internal/attachments/url-refs.js";

export function createSendFn<TState = undefined>(
  runtime: Runtime,
  adapter: ChannelAdapter<any>,
  channelName: string,
  metadata: { readonly requestId?: string } = {},
): SendFn<TState> {
  return async (
    input: string | UserContent | SendPayload,
    options: SendOptions<TState>,
  ): Promise<Session> => {
    // `SendOptions<TState>` is conditional on `TState`, so its properties are
    // not accessible until the generic resolves; widen once to the base shape.
    const opts = options as SendOptions<undefined> & { readonly state?: TState };
    const { auth, callback, caller, capabilities, initiatorAuth, state, title } = opts;
    const intent = opts.intent ?? "resume-or-start";
    const mode = opts.mode ?? "conversation";
    const rawToken = opts.continuationToken;
    const continuationToken = `${channelName}:${rawToken}`;

    const {
      message: rawMessage,
      inputResponses,
      context,
      outputSchema,
    } = normalizeSendInput(input);
    const message = serializeUrlFilePartsInMessage(rawMessage);

    const command: Extract<SessionCommand, { readonly kind: "send" }> = {
      auth,
      caller,
      kind: "send",
      payload: { inputResponses, message, context, outputSchema },
      requestId: metadata.requestId,
    };

    const dispatch = async (): Promise<Session | undefined> => {
      const result = await runtime.dispatchContinuation({
        command,
        continuationToken,
      });
      return result.status === "accepted"
        ? createSession(result.sessionId, rawToken, runtime)
        : undefined;
    };

    const existing = await dispatch();
    if (existing !== undefined) return existing;
    if (intent === "resume") throw new RuntimeNoActiveSessionError(continuationToken);

    if (inputResponses && inputResponses.length > 0) {
      throw new Error(
        "Cannot deliver inputResponses — the target session was not found via continuation token.",
      );
    }

    const sessionAdapter = state
      ? { ...adapter, state: { ...adapter.state, ...(state as Record<string, unknown>) } }
      : adapter;

    const runInput: {
      -readonly [K in keyof RunInput]: RunInput[K];
    } = {
      adapter: sessionAdapter,
      auth,
      capabilities: capabilities ?? (mode === "conversation" ? { requestInput: true } : undefined),
      channelName,
      callback,
      continuationToken,
      input: { message: message ?? "", context, outputSchema },
      mode,
      requestId: metadata.requestId,
      title,
    };
    if (initiatorAuth !== undefined) {
      runInput.initiatorAuth = initiatorAuth;
    }
    try {
      const handle = await runtime.createSession(runInput);
      return createSession(handle.sessionId, rawToken, runtime);
    } catch (error) {
      if (!isRuntimeSessionOwnershipConflictError(error)) throw error;
      const winner = await dispatch();
      if (winner !== undefined) return winner;
      throw error;
    }
  };
}

/**
 * Serializes `URL` objects in `FilePart.data` to `eve-url:` strings
 * before the message crosses the queue boundary. The staging pipeline
 * reconstitutes them on the other side.
 */
function serializeUrlFilePartsInMessage(
  message: string | UserContent | undefined,
): string | UserContent | undefined {
  if (message === undefined || typeof message === "string") {
    return message;
  }
  let changed = false;
  const result = message.map((part): FilePart | typeof part => {
    if (part.type === "file" && part.data instanceof URL && part.data.protocol !== "data:") {
      changed = true;
      return { ...part, data: serializeUrlFilePart(part.data) };
    }
    return part;
  });
  return changed ? result : message;
}

function normalizeSendInput(input: string | UserContent | SendPayload): SendPayload {
  if (typeof input === "string") {
    return { message: input };
  }

  if (Array.isArray(input)) {
    return { message: input };
  }

  return input;
}
