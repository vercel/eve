declare const lifetimeBrand: unique symbol;

export interface Lifetime {
  readonly [lifetimeBrand]: true;
}

type Cleanup = () => void | Promise<void>;

const STATE: unique symbol = Symbol.for("eve.lifetime");

interface LifetimeState {
  readonly cleanups: Cleanup[];
  readonly children: Set<Lifetime>;
  readonly parent: Lifetime | undefined;
  ending: Promise<void> | undefined;
}

type LifetimeRecord = Lifetime & { readonly [STATE]: LifetimeState };

export function createLifetime(parent?: Lifetime): Lifetime {
  const state: LifetimeState = { children: new Set(), cleanups: [], ending: undefined, parent };
  const lifetime = Object.freeze({ [STATE]: state }) as LifetimeRecord;
  if (parent !== undefined) openState(parent).children.add(lifetime);
  return lifetime;
}

export function registerCleanup(lifetime: Lifetime, cleanup: Cleanup): void {
  openState(lifetime).cleanups.push(cleanup);
}

export function endLifetime(lifetime: Lifetime): Promise<void> {
  const state = stateOf(lifetime);
  state.ending ??= finish(lifetime, state);
  return state.ending;
}

async function finish(lifetime: Lifetime, state: LifetimeState): Promise<void> {
  await Promise.resolve();
  for (const child of [...state.children].reverse()) await endLifetime(child);
  if (state.parent !== undefined) stateOf(state.parent).children.delete(lifetime);
  const failures: unknown[] = [];
  for (const cleanup of state.cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Several eve cleanups failed.");
}

function openState(lifetime: Lifetime): LifetimeState {
  const state = stateOf(lifetime);
  if (state.ending !== undefined) {
    throw new Error(
      "eve cannot add to a lifetime that has ended. Register cleanups and open sessions before the app stops.",
    );
  }
  return state;
}

function stateOf(lifetime: Lifetime): LifetimeState {
  return (lifetime as LifetimeRecord)[STATE];
}
