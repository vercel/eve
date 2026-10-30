import type { PromptQueueState } from "#channel/prompt-queue.js";
import type { RouteHandler } from "#channel/routes.js";
import type { SessionAuthContext, TurnPolicy } from "#channel/types.js";
import { createLogger } from "#internal/logging.js";
import type { SessionEvent } from "#protocol/session-event.js";
import {
  defineChannel,
  POST,
  type Channel,
  type ChannelContinuationOps,
  type ChannelEventContext,
  type ChannelEventOf,
} from "#public/definitions/channel.js";
import {
  getReceivedEmail,
  sendResendEmail,
  type ResendApiOptions,
  type ResendSendEmailInput,
} from "#public/channels/resend/api.js";
import { defaultEvents, defaultOnEmail } from "#public/channels/resend/defaults.js";
import {
  formatResendContextBlock,
  parseResendReceivedEvent,
  replySubject,
  resendContinuationToken,
  resendThreadRoot,
  toResendEmail,
  type ResendEmail,
} from "#public/channels/resend/inbound.js";
import {
  verifyResendInbound,
  type ResendChannelCredentials,
} from "#public/channels/resend/verify.js";

const log = createLogger("resend.channel");

/** JSON-serializable state for one email thread. */
export interface ResendChannelState extends PromptQueueState {
  /** Bare address of the person the agent emails with. */
  address: string | null;
  /** Subject of the latest received email. */
  subject: string | null;
  /** `Message-ID`s in the thread, oldest first, ending with the latest received email. */
  references: string[];
  /** @internal The sign-ins the default flow sent a prompt for, by connection name. */
  pendingSignIns?: Record<string, string>;
}

/** Per-session instrumentation snapshot for Resend runtime telemetry. */
export interface ResendInstrumentationMetadata extends Record<string, unknown> {
  readonly address: string | null;
  readonly lastMessageId: string | null;
}

/** Low-level Resend handle exposed to hooks and event handlers. */
export interface ResendHandle {
  /** Address of the person the agent emails with in this thread. */
  readonly address: string;
  /** Replies in the thread with a plain-text body. */
  reply(text: string): Promise<{ readonly id: string }>;
  /** Sends any email from the channel's API key. `from` defaults to the channel's sender. */
  sendEmail(
    email: Omit<ResendSendEmailInput, "from"> & { readonly from?: string },
  ): Promise<{ readonly id: string }>;
}

/** Pre-dispatch context passed to {@link ResendChannelConfig.onEmail}. */
export interface ResendContext {
  readonly resend: ResendHandle;
}

/** Channel-owned context returned by `context()`. */
export interface ResendChannelContext extends ResendContext {
  state: ResendChannelState;
}

/** Event-handler context, including continuation routing. */
export interface ResendEventContext extends ResendChannelContext, ChannelContinuationOps {}

/** Result of {@link ResendChannelConfig.onEmail}. Return `null` to drop the email. */
export type ResendInboundResult = {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
  /** Overrides the workflow run title without changing the message sent to the model. */
  readonly title?: string;
} | null;

/**
 * Sender addresses allowed to reach the agent. An entry that starts with `@` allows a whole
 * domain, such as `"@acme.com"`. `"*"` allows every verified email.
 */
export type ResendAllowFrom =
  | string
  | readonly string[]
  | (() => string | readonly string[] | Promise<string | readonly string[]>);

type ResendEventHandler<T extends SessionEvent["type"]> = (
  event: ChannelEventOf<T>,
  ctx: ChannelEventContext<ResendEventContext>,
) => void | Promise<void>;

/** Event handlers supported by `resendChannel({ events })`. */
export interface ResendChannelEvents {
  readonly "turn.started"?: ResendEventHandler<"turn.started">;
  readonly "content.completed"?: ResendEventHandler<"content.completed">;
  readonly "interaction.opened"?: ResendEventHandler<"interaction.opened">;
  readonly "interaction.settled"?: ResendEventHandler<"interaction.settled">;
  readonly "turn.settled"?: ResendEventHandler<"turn.settled">;
  readonly "session.ended"?: ResendEventHandler<"session.ended">;
}

/** Configuration for {@link resendChannel}. */
export interface ResendChannelConfig {
  /** Address the agent sends from, on a Resend domain that can also receive replies. */
  readonly fromAddress: string;
  /** Display name for the `From` header. */
  readonly fromName?: string;
  /** Sender addresses or `@domain`s allowed to reach the agent, or `"*"` for everyone. */
  readonly allowFrom: ResendAllowFrom;
  /** API key and webhook verification. With no verifier or secret, accepts Vercel Connect. */
  readonly credentials?: ResendChannelCredentials;
  /** Override the default webhook route (`/eve/v1/resend`). */
  readonly route?: string;
  /** Policy for accepted emails that arrive while a turn is active. */
  readonly turnPolicy?: TurnPolicy;
  readonly api?: ResendApiOptions;
  /** Inbound hook. Defaults to sender-address auth, dropping emails that fail DMARC. */
  onEmail?(
    ctx: ResendContext,
    email: ResendEmail,
  ): ResendInboundResult | Promise<ResendInboundResult>;
  readonly events?: ResendChannelEvents;
}

/** Concrete return type of {@link resendChannel}. */
export interface ResendChannel extends Channel<
  ResendChannelState,
  undefined,
  ResendInstrumentationMetadata
> {}

/**
 * Creates an eve channel that holds email conversations through Resend. Each email thread is
 * one session, and replies go back in the same thread.
 *
 * @example
 * ```ts
 * import { connectResendCredentials } from "@vercel/connect/eve";
 * import { resendChannel } from "eve/channels/resend";
 *
 * export default resendChannel({
 *   allowFrom: "@acme.com",
 *   credentials: connectResendCredentials("resend/my-agent"),
 *   fromAddress: "agent@acme.com",
 * });
 * ```
 */
export function resendChannel(config: ResendChannelConfig): ResendChannel {
  if (config?.allowFrom === undefined) {
    throw new Error('resendChannel requires allowFrom. Use allowFrom: "*" to allow every sender.');
  }
  const onEmail = config.onEmail ?? defaultOnEmail;

  return defineChannel<
    ResendChannelState,
    ResendChannelContext,
    undefined,
    ResendInstrumentationMetadata
  >({
    turnPolicy: config.turnPolicy,
    state: { address: null, references: [], subject: null },
    metadata(state): ResendInstrumentationMetadata {
      return { address: state.address, lastMessageId: state.references.at(-1) ?? null };
    },
    audience: () => "private",
    context(state) {
      return { resend: buildResendHandle(config, state), state };
    },
    routes: [
      POST<ResendChannelState>(config.route ?? "/eve/v1/resend", handleWebhook(config, onEmail)),
    ],
    events: { ...defaultEvents, ...config.events },
  });
}

function handleWebhook(
  config: ResendChannelConfig,
  onEmail: NonNullable<ResendChannelConfig["onEmail"]>,
): RouteHandler<ResendChannelState> {
  return async (req, { from, waitUntil }) => {
    const body = await verifyResendInbound(req, config.credentials);
    if (body === null) return new Response("unauthorized", { status: 401 });

    const event = parseResendReceivedEvent(body);
    if (event === null) return new Response(null, { status: 204 });
    if (!(await isAllowed(event.address, config.allowFrom))) {
      return new Response(null, { status: 204 });
    }

    waitUntil(
      (async () => {
        try {
          const payload = await getReceivedEmail({
            api: config.api,
            apiKey: config.credentials?.apiKey,
            emailId: event.emailId,
          });
          const email = toResendEmail(payload);
          // The fetched email is authoritative; recheck in case it differs from the webhook.
          if (email === null || !(await isAllowed(email.address, config.allowFrom))) return;
          const state = stateFor(email);
          const result = await onEmail({ resend: buildResendHandle(config, state) }, email);
          if (result === null || result === undefined) return;
          if (email.body.length === 0 && email.attachments.length === 0) return;

          await from(
            resendContinuationToken({
              address: email.address,
              rootMessageId: resendThreadRoot(email),
            }),
          ).send(email.body.length > 0 ? email.body : "(no text)", {
            auth: result.auth,
            context: [...(result.context ?? []), formatResendContextBlock(email)],
            idempotencyKey: `resend:${email.id}`,
            state,
            title: result.title ?? (email.subject || undefined),
          });
        } catch (error) {
          log.error("email dispatch failed", { error });
        }
      })(),
    );
    return new Response(null, { status: 202 });
  };
}

function stateFor(email: ResendEmail): ResendChannelState {
  return {
    address: email.address,
    references: [...email.references, email.messageId],
    subject: email.subject,
  };
}

function buildResendHandle(config: ResendChannelConfig, state: ResendChannelState): ResendHandle {
  const sender = config.fromName
    ? `${config.fromName} <${config.fromAddress}>`
    : config.fromAddress;
  const sendEmail: ResendHandle["sendEmail"] = (email) =>
    sendResendEmail({
      api: config.api,
      apiKey: config.credentials?.apiKey,
      email: { ...email, from: email.from ?? sender },
    });
  return {
    address: state.address ?? "",
    reply(text) {
      if (!state.address) {
        return Promise.reject(
          new Error("resendChannel: this session has no email thread to reply in."),
        );
      }
      const inReplyTo = state.references.at(-1);
      return sendEmail({
        headers: inReplyTo
          ? { "In-Reply-To": inReplyTo, References: state.references.join(" ") }
          : undefined,
        subject: replySubject(state.subject ?? ""),
        text,
        to: [state.address],
      });
    },
    sendEmail,
  };
}

async function isAllowed(address: string, allowFrom: ResendAllowFrom): Promise<boolean> {
  const resolved = typeof allowFrom === "function" ? await allowFrom() : allowFrom;
  const entries = (typeof resolved === "string" ? [resolved] : resolved).map((entry) =>
    entry.trim().toLowerCase(),
  );
  const domain = address.slice(address.lastIndexOf("@"));
  return entries.some((entry) => entry === "*" || entry === address || entry === domain);
}
