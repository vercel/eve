import type { TaskCardView } from "#channel/task-card.js";
import type { ChannelEventContext, ChannelEventOf } from "#public/definitions/channel.js";
import type { BlockKitBlock } from "#public/channels/slack/blocks.js";
import type { SlackMessage } from "#public/channels/slack/inbound.js";
import type {
  SlackAuthorizationEventContext,
  SlackChannelInternalEvents,
  SlackContext,
  SlackEventContext,
} from "#public/channels/slack/slackChannel.js";

/** The session events a Slack renderer can handle, in no particular order. */
const SLACK_RENDERED_EVENTS = [
  "call.progress",
  "call.requested",
  "call.started",
  "call.settled",
  "content.completed",
  "content.delta",
  "delivery.settled",
  "interaction.opened",
  "interaction.settled",
  "model.started",
  "response.settled",
  "session.ended",
  "task.ended",
  "task.started",
  "turn.paused",
  "turn.settled",
  "turn.started",
] as const;

export type SlackRenderedEvent = (typeof SLACK_RENDERED_EVENTS)[number];
type SlackSessionEvent = Exclude<SlackRenderedEvent, "interaction.opened">;

/**
 * Runs the rest of the chain, ending with eve's default. Pass a changed event to
 * hand it on instead of this one; the rest of the chain runs at most once.
 * Await it, so the rest of the chain finishes before the event does.
 */
export type SlackRenderNext<T extends SlackRenderedEvent> = (
  event?: ChannelEventOf<T>,
) => Promise<void>;

/** Renders one session event, before, after, around, or instead of the rest of the chain. */
export type SlackRenderHandler<T extends SlackSessionEvent> = (
  event: ChannelEventOf<T>,
  ctx: ChannelEventContext<SlackEventContext>,
  next: SlackRenderNext<T>,
) => void | Promise<void>;

/**
 * Session event handlers of one {@link SlackRenderer}. For a sign-in, `interaction.opened`
 * receives only the private delivery surface as `ctx.channel`, because the challenge is a
 * credential; its `next` reaches eve's default, which posts the public, link-free status. Any
 * other `interaction.opened` receives the full channel context.
 */
export type SlackRendererEvents = {
  readonly [T in SlackSessionEvent]?: SlackRenderHandler<T>;
} & {
  readonly "interaction.opened"?: (
    event: ChannelEventOf<"interaction.opened">,
    ctx: ChannelEventContext<SlackEventContext | SlackAuthorizationEventContext>,
    next: SlackRenderNext<"interaction.opened">,
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
   * is still deciding, and another channel message once `onMessage`
   * dispatches it. eve's default sets the `Thinking...` status. If the hook
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
   * Returns the message for a turn's task card, or `null` for none. Runs for
   * every turn that calls a tool; the view carries the turn's tasks and its
   * other tool calls with their input. Pure and synchronous: eve posts the
   * card, updates it as the turn changes, and handles Slack's rate limits.
   * `next` returns eve's default card, which is `null` for a turn without tasks.
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

/**
 * A complete chain, whose handlers take no `next`: eve's default renderer,
 * which is the innermost link, and the composed chain a channel runs.
 */
export interface SlackRenderChain {
  readonly events: SlackChannelInternalEvents;
  readonly received: (message: SlackMessage, channel: SlackContext) => Promise<void>;
  readonly taskCard: (view: TaskCardView) => SlackTaskCard | null;
}

type AnyHandler = (...args: unknown[]) => void | Promise<void>;

export function composeSlackRenderers(
  renderers: readonly SlackRenderer[],
  defaults: SlackRenderChain,
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
    events[type] = (event, ctx) =>
      runChain(
        handlers,
        event,
        (handler, value, next) =>
          handler(
            value,
            userContext(type, ctx as ChannelEventContext<SlackEventContext>, value),
            next,
          ),
        (value) => fallback?.(value, ctx),
      );
  }
  return events as SlackChannelInternalEvents;
}

/**
 * Runs `handlers` in order around `last`. Each handler's `next` runs the rest
 * once, with the event it passes or the event it received.
 */
async function runChain(
  handlers: readonly AnyHandler[],
  event: unknown,
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
  await run(0, event);
}

/** User renderers see only the private delivery surface for a sign-in challenge. */
function userContext(
  type: SlackRenderedEvent,
  ctx: ChannelEventContext<SlackEventContext>,
  event: unknown,
): ChannelEventContext<SlackEventContext | SlackAuthorizationEventContext> {
  if (type !== "interaction.opened" || !isSignIn(event)) return ctx;
  const { channel } = ctx;
  const restricted: SlackAuthorizationEventContext = {
    postDirectMessage: (userId, message) => channel.thread.postDirectMessage(userId, message),
    postEphemeral: (userId, message) => channel.thread.postEphemeral(userId, message),
    state: channel.state,
  };
  return { ...ctx, channel: restricted };
}

function isSignIn(event: unknown): boolean {
  return (
    (event as Partial<ChannelEventOf<"interaction.opened">> | undefined)?.data?.request?.kind ===
    "sign-in"
  );
}

async function composeReceived(
  renderers: readonly SlackRenderer[],
  defaults: SlackRenderChain,
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
  defaults: SlackRenderChain,
  view: TaskCardView,
  index: number,
): SlackTaskCard | null {
  if (index === renderers.length) return defaults.taskCard(view);
  const taskCard = renderers[index]!.taskCard;
  if (taskCard === undefined) return composeTaskCard(renderers, defaults, view, index + 1);
  return taskCard(view, (next) => composeTaskCard(renderers, defaults, next, index + 1));
}
