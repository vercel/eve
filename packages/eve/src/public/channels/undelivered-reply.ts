import type { ChannelDelivery } from "#shared/channel-delivery.js";
import { logError, type Logger } from "#internal/logging.js";
import { recordChannelDeliveryFailure } from "#tracing/eve/channel-delivery-span.js";

/** Channel state that remembers a final reply the user never saw. */
export interface UndeliveredReplyState {
  /**
   * Error id of a final reply that never reached the user. The next delivered
   * message tells the model the reply was not seen, then clears it.
   * @internal
   */
  undeliveredReplyErrorId?: string | null;
}

export interface UndeliveredReplySurface {
  readonly log: Logger;
  readonly name: string;
  readonly post: (notice: string) => Promise<unknown>;
  readonly state: UndeliveredReplyState;
}

export async function reportUndeliveredReply(
  surface: UndeliveredReplySurface,
  turnId: string,
  error: unknown,
): Promise<void> {
  const errorId = logError(surface.log, `final reply was not delivered to ${surface.name}`, error, {
    turnId,
  });
  recordChannelDeliveryFailure("reply_undelivered", errorId);
  surface.state.undeliveredReplyErrorId = errorId;
  try {
    await surface.post(
      `I finished, but couldn't deliver my answer in ${surface.name} (error id \`${errorId}\`). Please ask me to resend it.`,
    );
  } catch (noticeError) {
    logError(surface.log, "undelivered reply notice failed", noticeError, { errorId, turnId });
  }
}

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
