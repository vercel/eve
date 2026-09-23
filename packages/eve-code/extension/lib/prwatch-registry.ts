import { defineState } from "eve/context";

import { repoFullName } from "./prwatch-github.ts";

export interface PrwatchTarget {
  readonly pullRequestNumber: number;
  readonly repo: string;
}

export interface PrwatchRegistration extends PrwatchTarget {
  readonly callId: string;
}

export interface PrwatchRecord {
  readonly callId: string;
  readonly cancelled: boolean;
}

export interface PrwatchRegistryState {
  readonly watches: Readonly<Record<string, PrwatchRecord>>;
}

const prwatchState = defineState<PrwatchRegistryState>("eve-code.prwatch", () => ({ watches: {} }));

export function prwatchKey(input: PrwatchTarget): string {
  return `${repoFullName(input.repo)}#${input.pullRequestNumber}`;
}

export function emptyPrwatchRegistry(): PrwatchRegistryState {
  return { watches: {} };
}

export function registerPrwatchInState(
  state: PrwatchRegistryState,
  input: PrwatchRegistration,
): PrwatchRegistryState {
  const key = prwatchKey(input);
  const current = state.watches[key];
  if (current !== undefined && !current.cancelled) return state;
  return {
    watches: {
      ...state.watches,
      [key]: { callId: input.callId, cancelled: false },
    },
  };
}

export function isPrwatchCancelledInState(
  state: PrwatchRegistryState,
  input: PrwatchRegistration,
): boolean {
  const current = state.watches[prwatchKey(input)];
  return current === undefined || current.callId !== input.callId || current.cancelled;
}

export function cancelPrwatchInState(
  state: PrwatchRegistryState,
  input: PrwatchTarget,
): { readonly deleted: boolean; readonly state: PrwatchRegistryState } {
  const key = prwatchKey(input);
  const current = state.watches[key];
  if (current === undefined || current.cancelled) {
    return { deleted: false, state };
  }
  return {
    deleted: true,
    state: {
      watches: {
        ...state.watches,
        [key]: { ...current, cancelled: true },
      },
    },
  };
}

export function completePrwatchInState(
  state: PrwatchRegistryState,
  input: PrwatchRegistration,
): PrwatchRegistryState {
  const key = prwatchKey(input);
  if (state.watches[key]?.callId !== input.callId) return state;
  const { [key]: _removed, ...watches } = state.watches;
  return { watches };
}

export async function registerActivePrwatch(input: PrwatchRegistration): Promise<void> {
  prwatchState.update((state) => registerPrwatchInState(state, input));
}

export async function prwatchWasCancelled(input: PrwatchRegistration): Promise<boolean> {
  return isPrwatchCancelledInState(prwatchState.get(), input);
}

export async function finishPrwatch(input: PrwatchRegistration): Promise<void> {
  prwatchState.update((state) => completePrwatchInState(state, input));
}

export async function deletePrwatch(input: PrwatchTarget): Promise<boolean> {
  let deleted = false;
  prwatchState.update((state) => {
    const next = cancelPrwatchInState(state, input);
    deleted = next.deleted;
    return next.state;
  });
  return deleted;
}
