import type { TaskCardView } from "#channel/task-card.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { BlockKitBlock } from "#public/channels/slack/blocks.js";
import type { SlackMessage } from "#public/channels/slack/inbound.js";
import type {
  SlackAuthorizationEventContext,
  SlackChannelInternalEvents,
  SlackContext,
  SlackEventContext,
} from "#public/channels/slack/slackChannel.js";

type EventData<T extends UnstampedMessageStreamEvent["type"]> =
  Extract<UnstampedMessageStreamEvent, { type: T }> extends { data: infer D } ? D : undefined;

/** The session events a Slack renderer can handle, in no particular order. */
const SLACK_RENDERED_EVENTS = [
  "action.partial",
  "action.result",
  "actions.requested",
  "approval.candidate",
  "approval.settled",
  "authorization.completed",
  "authorization.required",
  "input.requested",
  "message.appended",
  "message.completed",
  "reasoning.appended",
  "reasoning.completed",
  "session.completed",
  "session.failed",
  "session.waiting",
  "task.settled",
  "task.started",
  "turn.cancelled",
  "turn.completed",
  "turn.failed",
  "turn.started",
  "turn.waiting",
] as const;

export type SlackRenderedEvent = (typeof SLACK_RENDERED_EVENTS)[number];
type SlackSessionEvent = Exclude<SlackRenderedEvent, "authorization.required" | "session.failed">;

/**
 * Runs the rest of the chain, ending with eve's default. Pass changed data to
 * hand it on instead of the event; the rest of the chain runs at most once.
 */
export type SlackRenderNext<T extends SlackRenderedEvent> = (data?: EventData<T>) => Promise<void>;

/** Renders one session event, before, after, around, or instead of the rest of the chain. */
export type SlackRenderHandler<T extends SlackSessionEvent> = (
  data: EventData<T>,
  channel: SlackEventContext,
  ctx: SessionContext,
  next: SlackRenderNext<T>,
) => void | Promise<void>;

/**
 * Session event handlers of one {@link SlackRenderer}. `authorization.required`
 * receives the private delivery surface, because the challenge is a
 * credential; its `next` reaches eve's default, which posts the public,
 * link-free status. `session.failed` has no session context.
 */
export type SlackRendererEvents = {
  readonly [T in SlackSessionEvent]?: SlackRenderHandler<T>;
} & {
  readonly "authorization.required"?: (
    data: EventData<"authorization.required">,
    channel: SlackAuthorizationEventContext,
    ctx: SessionContext,
    next: SlackRenderNext<"authorization.required">,
  ) => void | Promise<void>;
  readonly "session.failed"?: (
    data: EventData<"session.failed">,
    channel: SlackEventContext,
    next: SlackRenderNext<"session.failed">,
  ) => void | Promise<void>;
};

/** The message eve posts for a turn's tasks: Block Kit blocks and notification text. */
export interface SlackTaskCard {
  readonly blocks: readonly BlockKitBlock[];
  readonly text: string;
}

/**
 * One link in a Slack channel's rendering chain. Every part is optional and
 * wraps the renderers after it, ending with eve's default renderer.
 */
export interface SlackRenderer {
  /**
   * Acknowledges a mention or DM as soon as it arrives, while the message hook
   * is still deciding. eve's default sets the `Thinking...` status. If the hook
   * drops the message, eve clears the thread status.
   */
  readonly received?: (
    message: SlackMessage,
    channel: SlackContext,
    next: () => Promise<void>,
  ) => void | Promise<void>;
  /** Handlers for session events, such as posting replies and questions. */
  readonly events?: SlackRendererEvents;
  /**
   * Returns the message for a turn's task card, which shows the turn's plan
   * and tasks, or `null` for none. Pure and synchronous: eve posts the card,
   * updates it as the turn changes, and handles Slack's rate limits. `next`
   * returns eve's default card.
   */
  readonly taskCard?: (
    view: TaskCardView,
    next: (view: TaskCardView) => SlackTaskCard | null,
  ) => SlackTaskCard | null;
}

/** Types a Slack renderer. */
export function defineSlackRenderer(renderer: SlackRenderer): SlackRenderer {
  return renderer;
}

/** eve's default renderer: the innermost link, whose event handlers take no `next`. */
export interface SlackDefaultRenderer {
  readonly events: SlackChannelInternalEvents;
  readonly received: (message: SlackMessage, channel: SlackContext) => Promise<void>;
  readonly taskCard: (view: TaskCardView) => SlackTaskCard | null;
}

/** The composed chain a channel runs. */
export interface SlackRenderChain {
  readonly events: SlackChannelInternalEvents;
  readonly received: (message: SlackMessage, channel: SlackContext) => Promise<void>;
  readonly taskCard: (view: TaskCardView) => SlackTaskCard | null;
}

type AnyHandler = (...args: unknown[]) => void | Promise<void>;

export function composeSlackRenderers(
  renderers: readonly SlackRenderer[],
  defaults: SlackDefaultRenderer,
): SlackRenderChain {
  return {
    events: composeEvents(renderers, defaults.events),
    received: (message, channel) => composeReceived(renderers, defaults, message, channel, 0),
    taskCard: (view) => composeTaskCard(renderers, defaults, view, 0),
  };
}

function composeEvents(
  renderers: readonly SlackRenderer[],
  defaults: SlackChannelInternalEvents,
): SlackChannelInternalEvents {
  const events: Record<string, AnyHandler> = {};
  for (const type of SLACK_RENDERED_EVENTS) {
    const fallback = defaults[type] as AnyHandler | undefined;
    const handlers = renderers.flatMap((renderer) => {
      const handler = renderer.events?.[type] as AnyHandler | undefined;
      return handler === undefined ? [] : [handler];
    });
    if (handlers.length === 0 && fallback === undefined) continue;
    events[type] =
      type === "session.failed"
        ? (data, channel) =>
            runChain(
              handlers,
              data,
              (handler, value, next) => handler(value, channel, next),
              (value) => fallback?.(value, channel),
            )
        : (data, channel, ctx) =>
            runChain(
              handlers,
              data,
              (handler, value, next) =>
                handler(value, userChannel(type, channel as SlackEventContext), ctx, next),
              (value) => fallback?.(value, channel, ctx),
            );
  }
  return events as SlackChannelInternalEvents;
}

/**
 * Runs `handlers` in order around `last`. Each handler's `next` runs the rest
 * once, with the data it passes or the data it received.
 */
async function runChain(
  handlers: readonly AnyHandler[],
  data: unknown,
  invoke: (
    handler: AnyHandler,
    value: unknown,
    next: (value?: unknown) => Promise<void>,
  ) => unknown,
  last: (value: unknown) => unknown,
): Promise<void> {
  const run = async (index: number, value: unknown): Promise<void> => {
    if (index === handlers.length) {
      await last(value);
      return;
    }
    let ran: Promise<void> | undefined;
    const next = (changed?: unknown): Promise<void> =>
      (ran ??= run(index + 1, changed === undefined ? value : changed));
    await invoke(handlers[index]!, value, next);
  };
  await run(0, data);
}

/** User renderers see only the private delivery surface for a sign-in challenge. */
function userChannel(
  type: SlackRenderedEvent,
  channel: SlackEventContext,
): SlackEventContext | SlackAuthorizationEventContext {
  if (type !== "authorization.required") return channel;
  return {
    postDirectMessage: (userId, message) => channel.thread.postDirectMessage(userId, message),
    postEphemeral: (userId, message) => channel.thread.postEphemeral(userId, message),
    state: channel.state,
  };
}

async function composeReceived(
  renderers: readonly SlackRenderer[],
  defaults: SlackDefaultRenderer,
  message: SlackMessage,
  channel: SlackContext,
  index: number,
): Promise<void> {
  if (index === renderers.length) {
    await defaults.received(message, channel);
    return;
  }
  const received = renderers[index]!.received;
  if (received === undefined) {
    await composeReceived(renderers, defaults, message, channel, index + 1);
    return;
  }
  let ran: Promise<void> | undefined;
  await received(message, channel, () => {
    ran ??= composeReceived(renderers, defaults, message, channel, index + 1);
    return ran;
  });
}

function composeTaskCard(
  renderers: readonly SlackRenderer[],
  defaults: SlackDefaultRenderer,
  view: TaskCardView,
  index: number,
): SlackTaskCard | null {
  if (index === renderers.length) return defaults.taskCard(view);
  const taskCard = renderers[index]!.taskCard;
  if (taskCard === undefined) return composeTaskCard(renderers, defaults, view, index + 1);
  return taskCard(view, (next) => composeTaskCard(renderers, defaults, next, index + 1));
}
