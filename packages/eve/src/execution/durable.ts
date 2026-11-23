import type { SessionInboxAddress } from "#execution/session-inbox/address.js";
import type { App } from "#runtime/app.js";
import type { ConnectionEventOwners } from "#runtime/connections/events/owners.js";

declare const opaqueBrand: unique symbol;
export type Opaque<Tag extends string> = { readonly [opaqueBrand]: Tag };

export interface Durable {
  start(session: SessionStartInput): Promise<void>;
  deliver(
    to: DeliveryAddress,
    payload: unknown,
    options?: { readonly key?: string },
  ): Promise<void>;
  readStream(sessionId: string, from: number): AsyncIterable<StreamLine>;
  tail(sessionId: string): Promise<number>;
  status(sessionId: string): Promise<SessionStatus | undefined>;
  readonly runs?: WorkflowRuns;
  readonly connectionEvents?: ConnectionEventOwners;
}

export type SessionStatus = "running" | "parked" | "paused" | "ended" | "failed";

export interface SessionStartInput {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly addresses: readonly DeliveryAddress[];
  readonly body: Opaque<"eve.session-start">;
}

export interface DeliveryAddress {
  readonly key: string;
}

export interface StreamLine {
  readonly position: number;
  readonly line: string;
}

export interface WorkflowRuns {
  start(run: WorkflowRunStartInput): Promise<void>;
  status(runId: string): Promise<SessionStatus | undefined>;
}

export interface WorkflowRunStartInput {
  readonly runId: string;
  readonly workflowId: string;
  readonly input: Opaque<"eve.workflow-run">;
}

export type EngineApp = Pick<App, "platform" | "lifetime">;

export interface DurableEngine {
  readonly build?: BuildContribution;
  start(app: EngineApp): Durable | Promise<Durable>;
}

export interface BuildContribution {
  readonly routes?: readonly EngineRoute[];
  readonly entries?: Readonly<Record<string, string>>;
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
