import type { Client } from "#client/client.js";
import type { MessageResponse } from "#client/message-response.js";
import type { ClientSession } from "#client/session.js";
import type { SendTurnPayload } from "#client/types.js";

/** Send one turn through an owned or attached session, without choosing how to consume its stream. */
export async function dispatchSessionTurn<TOutput>(input: {
  client?: Client;
  session?: ClientSession;
  turn: SendTurnPayload<TOutput>;
  beforeSend?: () => void;
}): Promise<{ session: ClientSession; response: MessageResponse<TOutput>; created: boolean }> {
  const { client, session, turn, beforeSend } = input;
  if (session === undefined) {
    if (client === undefined)
      throw new Error("An external eve session is required before sending.");
    if (turn.message === undefined)
      throw new Error("Cannot answer an input request before the session starts.");
    const created = await client.sessions.create({ ...turn, message: turn.message });
    turn.signal?.throwIfAborted();
    return { ...created, created: true };
  }

  beforeSend?.();
  if (turn.inputResponses === undefined) {
    const { message, ...options } = turn;
    return { session, response: await session.send(message, options), created: false };
  }
  const { inputResponses, ...options } = turn;
  return { session, response: await session.respond(inputResponses, options), created: false };
}
