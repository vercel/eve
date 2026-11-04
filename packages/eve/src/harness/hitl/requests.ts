import type { AuthorizationChallenge } from "#harness/authorization.js";
import { signInInteractionId } from "#harness/interaction-facts.js";
import type { SessionStateMap } from "#harness/types.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { isObject } from "#shared/guards.js";
import type { PendingResponder } from "./responders.js";
import { parseRelay, type Relay } from "./relays.js";
import { resolveActiveAuthorizationChallenges } from "./sign-ins.js";

const REQUESTS_KEY = "eve.runtime.hitl.requests";

export interface HitlState {
  readonly signIns: readonly AuthorizationChallenge[];
  readonly responders: Readonly<Record<string, PendingResponder>>;
  readonly relays: ReadonlyMap<string, Relay>;
}

interface StoredRequests {
  readonly responders?: unknown;
  readonly signIns?: unknown;
  readonly relays?: unknown;
}

function readRequests(state: SessionStateMap | undefined): StoredRequests {
  const requests = state?.[REQUESTS_KEY];
  return isObject(requests) ? requests : {};
}

function record<T>(value: unknown): Readonly<Record<string, T>> {
  return isObject(value) && !Array.isArray(value) ? (value as Record<string, T>) : {};
}

export function readHitlState(state: SessionStateMap | undefined): HitlState {
  const raw = readRequests(state);
  let relays: ReadonlyMap<string, Relay> | undefined;
  return {
    signIns: Array.isArray(raw.signIns) ? raw.signIns : [],
    responders: record<PendingResponder>(raw.responders),
    get relays() {
      return (relays ??= new Map(
        Object.entries(record(raw.relays)).flatMap(([id, value]) => {
          const relay = parseRelay(value);
          return relay === undefined ? [] : [[id, relay] as const];
        }),
      ));
    },
  };
}

/** Unreadable checkpoint records must still prevent a handoff. */
export function holdsHitlRequests(state: SessionStateMap | undefined): boolean {
  const requests = state?.[REQUESTS_KEY];
  if (requests === undefined) return false;
  if (!isObject(requests) || Array.isArray(requests)) return true;
  const { signIns, relays } = requests as StoredRequests;
  return (
    signIns !== undefined ||
    (relays !== undefined && (!isObject(relays) || Object.keys(relays).length > 0))
  );
}

export interface HitlStateChange {
  readonly signIns?: readonly AuthorizationChallenge[];
  readonly relays?: Readonly<Record<string, Relay>>;
  readonly responders?: Readonly<Record<string, PendingResponder>>;
}

/** Changes and retirement share one save; the fold, not another ledger, owns record lifetime. */
export function writeHitlState<T extends { readonly state?: SessionStateMap }>(
  session: T,
  change: HitlStateChange,
  view?: SessionView,
): T {
  const stored = session.state?.[REQUESTS_KEY];
  if (
    change.signIns === undefined &&
    change.relays === undefined &&
    change.responders === undefined &&
    stored !== undefined &&
    (!isObject(stored) || Array.isArray(stored))
  )
    return session;
  const raw = readRequests(session.state);
  const current = readHitlState(session.state);
  const next: Record<string, unknown> = { ...raw };
  const put = (
    kind: keyof StoredRequests,
    value: readonly unknown[] | Readonly<Record<string, unknown>>,
  ) => {
    if (Object.keys(value).length > 0) next[kind] = value;
    else delete next[kind];
  };
  if (change.signIns !== undefined || (view !== undefined && current.signIns.length > 0)) {
    put(
      "signIns",
      resolveActiveAuthorizationChallenges(change.signIns ?? current.signIns).filter(
        (challenge) => view?.interactions[signInInteractionId(challenge)]?.status !== "settled",
      ),
    );
  }
  const kept = <V>(values: Readonly<Record<string, V>>, keep: (id: string) => boolean) =>
    Object.fromEntries(Object.entries(values).filter(([id]) => keep(id)));
  if (change.relays !== undefined || (view !== undefined && current.relays.size > 0)) {
    const relays = { ...record(raw.relays), ...change.relays };
    put(
      "relays",
      kept(
        relays,
        (id) =>
          view === undefined ||
          parseRelay(relays[id]) === undefined ||
          view.interactions[id]?.status === "open",
      ),
    );
  }
  if (change.responders !== undefined || view !== undefined) {
    put(
      "responders",
      kept(
        { ...current.responders, ...change.responders },
        (id) => view === undefined || (view.responses[id]?.status ?? "settled") !== "settled",
      ),
    );
  }
  const state: Record<string, unknown> = { ...session.state };
  delete state[REQUESTS_KEY];
  if (Object.keys(next).length > 0) state[REQUESTS_KEY] = next;
  return { ...session, state: Object.keys(state).length > 0 ? state : undefined };
}
