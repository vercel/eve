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
  const children = [...state.children].reverse().map((child) => () => endLifetime(child));
  const failures: unknown[] = [];
  for (const end of [...children, ...state.cleanups.splice(0).reverse()]) {
    try {
      await end();
    } catch (error) {
      failures.push(error);
    }
  }
  if (state.parent !== undefined) stateOf(state.parent).children.delete(lifetime);
  if (failures.length > 0) throw failures[0];
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
