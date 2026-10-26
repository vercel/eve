import type { ChannelDelivery } from "#shared/channel-delivery.js";
import { logError, type Logger } from "#internal/logging.js";

/** Channel state that remembers a final reply the user never saw. */
export interface UndeliveredReplyState {
  /**
   * Error id of a final reply that never reached the user. The next delivered
   * message tells the model the reply was not seen, then clears it.
   */
  undeliveredReplyErrorId?: string | null;
}

/** Where a channel's final reply failed, and how to post a notice there. */
export interface UndeliveredReplySurface {
  readonly log: Logger;
  /** The surface as the user and the model know it, e.g. `"Slack"`. */
  readonly name: string;
  readonly post: (notice: string) => Promise<unknown>;
  readonly state: UndeliveredReplyState;
}

/**
 * Records a final reply that failed to reach the user: logs `error` at error
 * level, remembers its error id for {@link withUndeliveredReplyNote}, and
 * posts a notice that names the id without repeating the reply. A failed
 * notice is logged, not thrown.
 */
export async function reportUndeliveredReply(
  surface: UndeliveredReplySurface,
  turnId: string,
  error: unknown,
): Promise<void> {
  const errorId = logError(surface.log, `final reply was not delivered to ${surface.name}`, error, {
    turnId,
  });
  surface.state.undeliveredReplyErrorId = errorId;
  try {
    await surface.post(
      `I finished, but couldn't deliver my answer in ${surface.name} (error id \`${errorId}\`). Please ask me to resend it.`,
    );
  } catch (noticeError) {
    logError(surface.log, "undelivered reply notice failed", noticeError, { errorId, turnId });
  }
}

/**
 * Tells the model, ahead of the next message, that its previous reply never
 * reached `surfaceName`, so it does not assume the user read that reply.
 */
export function withUndeliveredReplyNote<T extends ChannelDelivery<unknown>>(
  state: UndeliveredReplyState,
  payload: T,
  surfaceName: string,
): T {
  const errorId = state.undeliveredReplyErrorId;
  if (!errorId || payload.message === undefined) return payload;
  state.undeliveredReplyErrorId = null;
  const note = [
    `Your previous reply was not delivered to ${surfaceName} (error id ${errorId}).`,
    "The user has not seen it. Do not assume they read it; send the answer again if they ask for it.",
  ].join(" ");
  return { ...payload, context: [note, ...(payload.context ?? [])] };
}
