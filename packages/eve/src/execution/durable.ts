import type { SessionStrandedError } from "#channel/session-stranded-error.js";
import type { RemoteChildBinding } from "#execution/child-binding.js";
import type { SessionInboxAddress } from "#execution/session-inbox/address.js";
import type { PrewarmSessionResult } from "#protocol/prewarm-session.js";
import type { App } from "#runtime/app.js";
import type { ConnectionEventOwners } from "#runtime/connections/events/owners.js";

declare const opaqueBrand: unique symbol;
export type Opaque<Tag extends string> = { readonly [opaqueBrand]: Tag };

export interface Durable {
  start(session: SessionStartInput): Promise<SessionStartResult>;
  deliver(
    to: DeliveryAddress,
    payload: unknown,
    options?: { readonly key?: string },
  ): Promise<DeliveryResult>;
  sessionFor(
    address: DeliveryAddress,
    options?: { readonly live?: boolean },
  ): Promise<string | undefined>;
  readStream(sessionId: string, from: number): AsyncIterable<StreamLine>;
  tail(sessionId: string): Promise<number>;
  status(sessionId: string): Promise<SessionStatus | undefined>;
  readChildBinding?(
    sessionId: string,
    childSessionId: string,
  ): Promise<RemoteChildBinding | undefined>;
  readonly connectionEvents?: ConnectionEventOwners;
}

export type SessionStartResult =
  | { readonly kind: "started"; readonly sessionId: string }
  | { readonly kind: "held" };

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

export type SessionStatus = "running" | "parked" | "paused" | "ended" | "failed";

export interface SessionStartInput {
  readonly sessionId?: string;
  readonly parentSessionId?: string;
  readonly addresses: readonly DeliveryAddress[];
  readonly body: Opaque<"eve.session-start">;
}

export interface DeliveryAddress {
  readonly key: string;
}

export interface InboxItem {
  readonly id: string;
  readonly seq: number;
  readonly body:
    | { readonly kind: "deliver"; readonly to: DeliveryAddress; readonly payload: unknown }
    | { readonly kind: "cancel"; readonly reason: string };
}

export interface StepSignals {
  readonly cancel: AbortSignal;
  readonly steer: AbortSignal;
}

export interface StepMeta {
  readonly key: string;
  readonly sessionId: string;
  readonly attempt: number;
  readonly deadline?: number;
  readonly signals?: StepSignals;
}

export interface SessionInterrupts {
  poll?(sessionId: string, afterSeq: number): Promise<readonly InboxItem[]>;
}

export interface SessionStreamSink {
  tail(sessionId: string): Promise<number>;
  append(sessionId: string, from: number, lines: readonly string[]): Promise<void>;
  close(sessionId: string): Promise<void>;
}

export interface SessionContentStore {
  put(sessionId: string, content: Uint8Array): Promise<string>;
  get(sessionId: string, id: string): Promise<Uint8Array>;
  delete(sessionId: string): Promise<void>;
}

export interface StreamLine {
  readonly position: number;
  readonly line: string;
}

export type EngineApp = Pick<App, "platform" | "lifetime" | "hosts">;

export interface DurableEngine<Context = undefined> {
  readonly build?: BuildContribution;
  start(app: EngineApp, context: Context): Durable | Promise<Durable>;
}

export interface BuildContribution {
  readonly routes?: readonly EngineRoute[];
  readonly entries?: Readonly<Record<string, string>>;
  readonly runs?: boolean;
}

export interface EngineRoute {
  readonly path: string;
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
