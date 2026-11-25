import type { SessionStrandedError } from "#channel/session-stranded-error.js";
import type { RemoteChildBinding } from "#execution/child-binding.js";
import type { SessionInboxAddress } from "#execution/session-inbox/address.js";
import type { PrewarmSessionResult } from "#protocol/prewarm-session.js";
import type { App } from "#runtime/app.js";
import type { ConnectionEventOwners } from "#runtime/connections/events/owners.js";

declare const opaqueBrand: unique symbol;
/** A value that eve makes and reads. An engine keeps it and passes it back unchanged. */
export type Opaque<Tag extends string> = { readonly [opaqueBrand]: Tag };

/**
 * The operations that eve calls on a started durable engine. Each operation is generic: eve does
 * not know how the engine keeps sessions.
 */
export interface Durable {
  /** Starts a session that owns the addresses of `session`. */
  start(session: SessionStartInput): Promise<SessionStartResult>;
  /** Delivers a payload to the session that owns `to`. `key` makes the delivery idempotent. */
  deliver(
    to: DeliveryAddress,
    payload: unknown,
    options?: { readonly key?: string },
  ): Promise<DeliveryResult>;
  /** Returns the ID of the session that owns `address`. With `live`, only a session that runs. */
  sessionFor(
    address: DeliveryAddress,
    options?: { readonly live?: boolean },
  ): Promise<string | undefined>;
  /** Reads the stream lines of a session from position `from`, and follows new lines. */
  readStream(sessionId: string, from: number): AsyncIterable<StreamLine>;
  /** Returns the position of the last stream line of a session. */
  tail(sessionId: string): Promise<number>;
  /** Returns the status of a session, or `undefined` when the engine does not know it. */
  status(sessionId: string): Promise<SessionStatus | undefined>;
  /** Reads the binding of a child session that runs on another deployment. */
  readChildBinding?(
    sessionId: string,
    childSessionId: string,
  ): Promise<RemoteChildBinding | undefined>;
  /** The owners of connection events, when the engine routes them. */
  readonly connectionEvents?: ConnectionEventOwners;
}

/** The result of {@link Durable.start}: the session started, or another session holds an address. */
export type SessionStartResult =
  | { readonly kind: "started"; readonly sessionId: string }
  | { readonly kind: "held" };

/**
 * The result of {@link Durable.deliver}. A refused delivery tells why: no session runs, or the
 * session must be replaced, and `end()` ends it.
 */
export type DeliveryResult =
  | {
      readonly accepted: true;
      readonly sessionId?: string;
      readonly inbox?: string;
      readonly prewarm?: Exclude<PrewarmSessionResult["status"], "no_active_session">;
    }
  | { readonly accepted: false; readonly reason: "inactive"; readonly cause: unknown }
  | {
      readonly accepted: false;
      readonly reason: "replace";
      readonly cause: SessionStrandedError;
      end(): Promise<string>;
    };

/** The status of a session in its engine. */
export type SessionStatus = "running" | "parked" | "paused" | "ended" | "failed";

/** What eve gives to {@link Durable.start}. */
export interface SessionStartInput {
  /** The ID of the session, when eve chooses it. Otherwise the engine chooses it. */
  readonly sessionId?: string;
  /** The ID of the parent session of a subagent. */
  readonly parentSessionId?: string;
  /** The addresses that the session owns. Deliveries to them reach its inbox. */
  readonly addresses: readonly DeliveryAddress[];
  /** The start of the session, which `runSession()` reads. */
  readonly body: Opaque<"eve.session-start">;
}

/** An address that a session owns. Compare addresses by `key`. */
export interface DeliveryAddress {
  /** The key of the address. */
  readonly key: string;
}

/** One item in the inbox of a session. */
export interface InboxItem {
  /** The ID of the delivery. */
  readonly id: string;
  /** The position of the item in the inbox. Items have no gaps. */
  readonly seq: number;
  /** A delivered payload, or the cancellation of a delivery. */
  readonly body:
    | { readonly kind: "deliver"; readonly to: DeliveryAddress; readonly payload: unknown }
    | { readonly kind: "cancel"; readonly reason: string };
}

/** The signals that a step reads while it runs. */
export interface StepSignals {
  /** Aborts when eve cancels the turn of the step. */
  readonly cancel: AbortSignal;
  /** Aborts when new input steers the turn of the step. */
  readonly steer: AbortSignal;
}

/** The facts of one step call that the engine gives to the step. */
export interface StepMeta {
  /** The key of the step call, which stays the same when the engine retries it. */
  readonly key: string;
  /** The ID of the session of the step. */
  readonly sessionId: string;
  /** The attempt of the step call, from 1. */
  readonly attempt: number;
  /** The time, in milliseconds since the epoch, when the step must end. */
  readonly deadline?: number;
  /** The signals of the step. */
  readonly signals?: StepSignals;
}

/** Lets a running step read new inbox items, so that input can steer or cancel it. */
export interface SessionInterrupts {
  /** Returns the inbox items of a session after `afterSeq`. */
  poll?(sessionId: string, afterSeq: number): Promise<readonly InboxItem[]>;
}

/** Where the stream lines of sessions stay. */
export interface SessionStreamSink {
  /** Returns the position of the last line of a session, or `0` when it has none. */
  tail(sessionId: string): Promise<number>;
  /** Appends lines at position `from`. A repeated append at the same position has no effect. */
  append(sessionId: string, from: number, lines: readonly string[]): Promise<void>;
  /** Marks the stream of a session as complete. */
  close(sessionId: string): Promise<void>;
}

/** Where the large content of sessions stays, out of line from their records. */
export interface SessionContentStore {
  /** Keeps content and returns its ID. */
  put(sessionId: string, content: Uint8Array): Promise<string>;
  /** Returns the content with an ID. */
  get(sessionId: string, id: string): Promise<Uint8Array>;
  /** Deletes the content of a session. */
  delete(sessionId: string): Promise<void>;
}

/** One line of the stream of a session. */
export interface StreamLine {
  /** The position of the line, from 1. */
  readonly position: number;
  /** The line, a JSON event. */
  readonly line: string;
}

/** The parts of the app that {@link DurableEngine.start} receives. */
export type EngineApp = Pick<App, "platform" | "lifetime" | "hosts">;

/** A durable engine: the service that keeps sessions and runs them. */
export interface DurableEngine<Context = undefined> {
  /** Data that the build reads, such as the entries of the engine. */
  readonly build?: BuildContribution;
  /** Starts the engine at run time, and opens its resources. */
  start(app: EngineApp, context: Context): Durable | Promise<Durable>;
}

/** What a durable engine adds to the build. */
export interface BuildContribution {
  /** Routes of the engine. Only the Workflow engine gives routes so far. */
  readonly routes?: readonly EngineRoute[];
  /** Server entries of the engine, by name, as module paths. */
  readonly entries?: Readonly<Record<string, string>>;
  /** Whether the engine runs authored workflows. */
  readonly runs?: boolean;
}

/** A route of a durable engine. */
export interface EngineRoute {
  /** The path of the route. */
  readonly path: string;
  /** The module that handles the route. */
  readonly handler: string;
}

export function opaque<Tag extends string>(value: unknown): Opaque<Tag> {
  return value as Opaque<Tag>;
}

export function reveal<T>(value: Opaque<string>): T {
  const data: unknown = value;
  return data as T;
}

export function hookAddress(token: string): DeliveryAddress {
  return { key: `hook:${token}` };
}

export function sessionAddress(address: string | SessionInboxAddress): DeliveryAddress {
  return { key: `session:${JSON.stringify(address)}` };
}

export function signInAddress(token: string): DeliveryAddress {
  return { key: `sign-in:${token}` };
}

export type DecodedDeliveryAddress =
  | { readonly kind: "hook"; readonly token: string }
  | { readonly kind: "session"; readonly address: string | SessionInboxAddress }
  | { readonly kind: "sign-in"; readonly token: string };

export function decodeDeliveryAddress({ key }: DeliveryAddress): DecodedDeliveryAddress {
  const separator = key.indexOf(":");
  const rest = key.slice(separator + 1);
  switch (key.slice(0, separator)) {
    case "hook":
      return { kind: "hook", token: rest };
    case "session":
      return { kind: "session", address: JSON.parse(rest) as string | SessionInboxAddress };
    case "sign-in":
      return { kind: "sign-in", token: rest };
    default:
      throw new Error(`"${key}" is not a delivery address that eve made.`);
  }
}

export async function delivered(result: Promise<DeliveryResult>): Promise<void> {
  const settled = await result;
  if (!settled.accepted) throw settled.cause;
}

export function lineWritable(lines: {
  write(lines: readonly string[]): Promise<void>;
  close(): Promise<void>;
}): WritableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffered = "";
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      buffered += decoder.decode(chunk, { stream: true });
      const complete = buffered.split("\n");
      buffered = complete.pop() ?? "";
      if (complete.length > 0) await lines.write(complete);
    },
    close: () => lines.close(),
  });
}

export async function* readStreamLines(
  readable: ReadableStream<Uint8Array>,
  from: number,
): AsyncIterable<StreamLine> {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let position = from;
  let buffered = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let end = buffered.indexOf("\n");
      while (end >= 0) {
        yield { position: position++, line: buffered.slice(0, end) };
        buffered = buffered.slice(end + 1);
        end = buffered.indexOf("\n");
      }
    }
    if (buffered.length > 0) yield { position, line: buffered };
  } finally {
    await reader.cancel().catch(() => {});
  }
}
