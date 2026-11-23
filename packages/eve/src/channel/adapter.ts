import type { SessionEvent } from "#protocol/session-event.js";
import { contentPhase } from "#protocol/session-events/catalog.js";
import type { ContextAccessor } from "#context/key.js";
import type { StepInput } from "#harness/types.js";
import { attachClientContext, readClientContext } from "#internal/client-context.js";
import { attachInputText, readInputText } from "#internal/input-text.js";
import { createLogger, logError } from "#internal/logging.js";
import type { FactPosition, Scope } from "#protocol/session-events/envelope.js";
import type { ChannelContext } from "#shared/channel-context.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import type { DeliverPayload } from "#channel/types.js";
import type { ChannelDelivery } from "#shared/channel-delivery.js";
import type { UploadPolicy } from "#public/channels/upload-policy.js";
import type {
  FetchFileContext,
  FetchFileResult,
  FetchFileFunction,
} from "#shared/channel-definition.js";
import type { ChannelAudienceProjector } from "#channel/audience.js";
import type { ChannelSpaceProjector } from "#channel/space.js";
import {
  recordChannelDeliveryFailure,
  withChannelDeliverySpan,
} from "#tracing/eve/channel-delivery-span.js";

const log = createLogger("channel.adapter");

export interface ChannelAdapterContext<TState = Record<string, unknown>> extends ChannelContext {
  state: TState;

  readonly ctx: ContextAccessor;

  /** @internal */
  readonly inputSource?: string;

  readonly position?: FactPosition;
  readonly scope?: Scope;
  readonly view?: SessionView;
  /** @internal */
  readonly waitUntil?: (task: Promise<unknown>) => void;
}

type StateOf<TCtx> = TCtx extends ChannelAdapterContext<infer S> ? S : Record<string, unknown>;

type EventHandler<
  T extends SessionEvent["type"],
  TCtx extends ChannelAdapterContext<any> = ChannelAdapterContext,
> = (event: Extract<SessionEvent, { type: T }>, ctx: TCtx) => void | Promise<void>;

export type ChannelEventHandlers<TCtx extends ChannelAdapterContext<any> = ChannelAdapterContext> =
  {
    [K in SessionEvent["type"]]?: EventHandler<K, TCtx>;
  } & {
    committed?: (line: CommittedLine, ctx: TCtx) => void | Promise<void>;
  };

/** A line the session committed: the facts its channel heard, in order, and its position. */
export interface CommittedLine {
  readonly facts: readonly SessionEvent[];
  readonly position: number;
}

export type { FetchFileContext, FetchFileResult };

export type ChannelInstrumentationMetadata = Readonly<Record<string, unknown>>;

export type ChannelInstrumentationMetadataProjector = (
  state: Record<string, unknown> | undefined,
) => ChannelInstrumentationMetadata;

export type ChannelAdapter<TCtx extends ChannelAdapterContext<any> = ChannelAdapterContext> = {
  readonly kind: string;

  readonly state?: Record<string, unknown>;

  deliver?(payload: DeliverPayload, ctx: TCtx): StepInput | void | Promise<StepInput | void>;

  /** @internal */
  createAdapterContext?(base: ChannelAdapterContext<StateOf<TCtx>>): TCtx;

  readonly fetchFile?: FetchFileFunction;

  readonly uploadPolicy?: UploadPolicy;

  readonly instrumentation?: {
    readonly metadata?: ChannelInstrumentationMetadataProjector;
    readonly audience?: ChannelAudienceProjector;
    readonly space?: ChannelSpaceProjector;
  };
} & ChannelEventHandlers<TCtx>;

export function defaultDeliverResult(
  payload: Pick<ChannelDelivery, "message" | "answers" | "context" | "outputSchema">,
): StepInput | undefined {
  if (payload.message !== undefined) {
    return attachClientContext(
      attachInputText(
        {
          answers: payload.answers,
          message: payload.message,
          context: payload.context,
          outputSchema: payload.outputSchema,
        },
        readInputText(payload),
      ),
      readClientContext(payload),
    );
  }

  if (payload.answers !== undefined && payload.answers.length > 0) {
    return attachClientContext(
      {
        answers: payload.answers,
        context: payload.context,
        outputSchema: payload.outputSchema,
      },
      readClientContext(payload),
    );
  }

  if (
    (payload.context !== undefined && payload.context.length > 0) ||
    (readClientContext(payload)?.length ?? 0) > 0
  ) {
    return attachClientContext(
      { context: payload.context, outputSchema: payload.outputSchema },
      readClientContext(payload),
    );
  }

  if (payload.outputSchema !== undefined) {
    return { outputSchema: payload.outputSchema };
  }

  return undefined;
}

export function getAdapterKind(adapter: ChannelAdapter): string {
  return adapter.kind;
}

export function seedChannelState(
  seed: Record<string, unknown> | undefined,
  state: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { ...structuredClone(seed), ...state };
}

export async function callAdapterEventHandler(
  adapter: ChannelAdapter,
  event: SessionEvent | CommittedLine,
  ctx: ChannelAdapterContext,
): Promise<void> {
  const type = "facts" in event ? "committed" : event.type;
  const handler = adapter[type] as
    | ((event: SessionEvent | CommittedLine, ctx: ChannelAdapterContext) => void | Promise<void>)
    | undefined;
  if (handler === undefined) return;
  const adapterKind = getAdapterKind(adapter);
  const delivery = {
    adapterKind,
    eventType: type,
    reachesPerson: reachesPerson(event),
    turnId: ctx.scope?.turnId,
  };
  await withChannelDeliverySpan(delivery, async () => {
    try {
      await handler(event, ctx);
    } catch (error) {
      const errorId = logError(log, "adapter event handler threw — event swallowed", error, {
        adapterKind,
        eventType: type,
      });
      recordChannelDeliveryFailure("channel_handler_failed", errorId);
    }
  });
}

function reachesPerson(event: SessionEvent | CommittedLine): boolean {
  if ("facts" in event) return false;
  if (event.type === "interaction.opened") return true;
  return (
    event.type === "content.completed" &&
    event.data.kind === "text" &&
    contentPhase(event.data.phase) === "reply"
  );
}
