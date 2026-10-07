import type { UserContent } from "ai";

import type { ChannelAdapter } from "#channel/adapter.js";
import type { ChannelDeliverySource } from "#channel/delivery-metadata.js";
import { createChannelAddressFn } from "#channel/channel-address.js";
import type { Session } from "#channel/session.js";
import type {
  CancelTurnResult,
  ClearSessionResult,
  CompactSessionResult,
  ResetSessionResult,
  Runtime,
  SessionAuthContext,
  SessionCallback,
  TurnPolicy,
} from "#channel/types.js";
import {
  type InputResponse,
  parseInputResponses,
  type StrictInputResponses,
} from "#shared/input.js";
import type { JsonObject } from "#shared/json.js";
import type { SessionHistoryMessage } from "#shared/session-history.js";
import { attachInputText, readInputText } from "#internal/input-text.js";

interface BaseChannelSendOptions {
  readonly auth: SessionAuthContext | null;
  readonly callback?: SessionCallback;
  readonly context?: readonly string[];
  /**
   * Prior conversation added as user and assistant turns before this
   * message and its `context`. Seeds a session this send creates, or
   * extends the history of the session that owns the address.
   */
  readonly history?: readonly SessionHistoryMessage[];
  readonly initiatorAuth?: SessionAuthContext | null;
  /** JSON Schema for a structured final answer, as on `Session.send()`. */
  readonly outputSchema?: JsonObject;
  readonly title?: string;
  readonly turnPolicy?: TurnPolicy;
}

/** Options for sending a message from a channel-local continuation address. */
export type ChannelSendOptions<TState = undefined> = [TState] extends [undefined]
  ? BaseChannelSendOptions
  : BaseChannelSendOptions & { readonly state: TState };

interface BaseChannelRespondOptions<TState = undefined> {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
  readonly state?: Partial<TState>;
}

/** Options for answering pending input requests at an existing continuation address. */
export type ChannelRespondOptions<TState = undefined> = BaseChannelRespondOptions<TState>;

interface BaseChannelCreateOptions {
  readonly auth: SessionAuthContext | null;
  /** Prior conversation the session starts with; it joins history with the first message. */
  readonly history?: readonly SessionHistoryMessage[];
  readonly initiatorAuth?: SessionAuthContext | null;
  readonly title?: string;
}

/** Options for creating a session at a channel-local address without running a turn. */
export type ChannelCreateOptions<TState = undefined> = [TState] extends [undefined]
  ? BaseChannelCreateOptions
  : BaseChannelCreateOptions & { readonly state: TState };

/** Dynamic handle for whichever session currently owns one channel-local address. */
export interface ChannelSource<TState = undefined> {
  /** Starts or resumes a turn with a user message. May create a session. */
  send(message: string | UserContent, options: ChannelSendOptions<TState>): Promise<Session>;
  /**
   * Creates a session that waits for its first message, without running a
   * turn. Returns the existing session, unchanged, when one owns the address.
   */
  create(options: ChannelCreateOptions<TState>): Promise<Session>;
  /** Answers pending input requests. Never creates a session. */
  respond<const TResponses extends readonly InputResponse[]>(
    inputResponses: StrictInputResponses<TResponses>,
    options: ChannelRespondOptions<TState>,
  ): Promise<Session>;
  /** Cooperatively cancels the active turn without creating a session. */
  cancel(options?: { readonly turnId?: string }): Promise<CancelTurnResult>;
  /** Queues context compaction without creating a session. */
  compact(): Promise<CompactSessionResult>;
  /** Clears model-message history without creating a session. */
  clear(): Promise<ClearSessionResult>;
  /** Retires the current owner without creating a replacement. */
  reset(options?: { readonly reason?: string }): Promise<ResetSessionResult>;
}

/** Binds a raw channel-local continuation address to its current-owner operations. */
export type ChannelFrom<TState = undefined> = (address: string) => ChannelSource<TState>;

/** Snapshots the session currently owning a channel-local continuation address. */
export type ChannelResolveSession = (address: string) => Promise<Session | undefined>;

/** Continuation operations passed to an authored channel's proactive `receive` hook. */
export interface ChannelReceiveContext<TState = undefined> {
  readonly from: ChannelFrom<TState>;
  readonly resolveSession: ChannelResolveSession;
}

/** Creates request-scoped channel operations backed by continuation dispatch. */
export function createChannelOperations<TState = undefined>(input: {
  readonly adapter: ChannelAdapter<any>;
  readonly channelName: string;
  readonly metadata?: ChannelDeliverySource;
  readonly runtime: Runtime;
  readonly turnPolicy?: TurnPolicy;
}): ChannelReceiveContext<TState> {
  const channelAddress = createChannelAddressFn<TState>(input);

  return {
    from(address) {
      const bound = channelAddress(address);
      const source: ChannelSource<TState> = {
        async send(message, options) {
          // Deliver hooks read per-delivery state (such as the message author)
          // from the payload, as they do for `respond()`.
          return await bound.deliver(
            attachInputText(
              {
                context: options.context,
                history: options.history,
                message,
                outputSchema: options.outputSchema,
                state: (options as { readonly state?: TState }).state,
              },
              readInputText(options),
            ),
            options,
          );
        },
        async create(options) {
          return await bound.create(options);
        },
        async respond(inputResponses, options) {
          if (inputResponses.length === 0) {
            throw new Error("respond() requires at least one input response.");
          }
          const validatedInputResponses = parseInputResponses(inputResponses);
          return await bound.deliver(
            {
              context: options.context,
              inputResponses: validatedInputResponses,
              state: options.state,
            },
            options,
          );
        },
        async cancel(options) {
          return await bound.cancel(options);
        },
        async compact() {
          return await bound.compact();
        },
        async clear() {
          return await bound.clear();
        },
        async reset(options) {
          return await bound.reset(options);
        },
      };
      return source;
    },
    async resolveSession(address) {
      return await channelAddress(address).resolveSession();
    },
  };
}
