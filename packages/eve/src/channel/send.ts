import type { FilePart, UserContent } from "ai";

import type { ChannelAdapter } from "#channel/adapter.js";
import type { Runtime, SessionAuthContext } from "#channel/types.js";
import { createSession, type Session } from "#channel/session.js";
import type { SendFn, SendOptions, SendPayload } from "#channel/routes.js";
import { isRuntimeNoActiveSessionError } from "#execution/runtime-errors.js";
import { serializeUrlFilePart } from "#internal/attachments/url-refs.js";
import { createLogger } from "#internal/logging.js";

const log = createLogger("channel.send");

export function createSendFn<TState = undefined>(
  runtime: Runtime,
  adapter: ChannelAdapter<any>,
  channelName: string,
): SendFn<TState> {
  return async (
    input: string | UserContent | SendPayload,
    options: SendOptions<TState>,
  ): Promise<Session> => {
    const auth = (options as { auth: SessionAuthContext | null }).auth;
    const callback = (options as { callback?: SendOptions<TState>["callback"] }).callback;
    const mode = (options as { mode?: SendOptions<TState>["mode"] }).mode ?? "conversation";
    const state = (options as { state?: TState }).state;
    const rawToken = (options as { continuationToken: string }).continuationToken;
    const continuationToken = `${channelName}:${rawToken}`;

    const {
      message: rawMessage,
      inputResponses,
      context,
      outputSchema,
    } = normalizeSendInput(input);
    const message = serializeUrlFilePartsInMessage(rawMessage);

    try {
      const { sessionId } = await runtime.deliver({
        auth,
        continuationToken,
        payload: { inputResponses, message, context, outputSchema },
      });

      return createSession(sessionId, rawToken, runtime);
    } catch (error) {
      // No-active-session is the expected resume-or-start signal. The
      // failure itself is logged in `deliver`; this only records the fallback.
      if (!isRuntimeNoActiveSessionError(error)) {
        log.warn("deliver failed, falling back to starting a new session", {
          continuationToken,
        });
      }
    }

    if (inputResponses && inputResponses.length > 0) {
      throw new Error(
        "Cannot deliver inputResponses — the target session was not found via continuation token.",
      );
    }

    const sessionAdapter = state
      ? { ...adapter, state: { ...adapter.state, ...(state as Record<string, unknown>) } }
      : adapter;

    const handle = await runtime.run({
      adapter: sessionAdapter,
      auth,
      capabilities: mode === "conversation" ? { requestInput: true } : undefined,
      channelName,
      callback,
      continuationToken,
      input: { message: message ?? "", context, outputSchema },
      mode,
    });

    return createSession(handle.sessionId, rawToken, runtime);
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
