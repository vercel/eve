/**
 * Races reads across several hooks. A read that lands while no race is waiting
 * is kept until one claims it: the owner awaits steps between races, and a
 * resume arriving then must not be dropped or re-issued. Claims follow array
 * order because separate hooks carry no order between them.
 */
export interface ChannelReader<C extends string, T> {
  readonly channel: C;
  readonly iterator: AsyncIterator<T>;
  /** Reads that have landed and not yet been claimed, oldest first. */
  readonly landed: IteratorResult<T>[];
  failure?: { readonly error: unknown };
  pending?: Promise<void>;
}

export function createChannelReader<C extends string, T>(
  channel: C,
  iterable: AsyncIterable<T>,
): ChannelReader<C, T> {
  return { channel, iterator: iterable[Symbol.asyncIterator](), landed: [] };
}

export type ChannelRead<R extends readonly ChannelReader<string, unknown>[]> = {
  [I in keyof R]: R[I] extends ChannelReader<infer C, infer T>
    ? { readonly channel: C; readonly next: IteratorResult<T> }
    : never;
}[number];

const EXTRA = Symbol("extra");

export async function raceChannelReads<
  const R extends readonly ChannelReader<string, unknown>[],
  X = never,
>(readers: R, extra?: Promise<X>): Promise<ChannelRead<R> | X> {
  const tagged = extra?.then((value) => ({ [EXTRA]: value }));
  while (true) {
    for (const reader of readers) {
      if (reader.failure !== undefined) throw reader.failure.error;
      const next = reader.landed.shift();
      if (next !== undefined) return { channel: reader.channel, next } as ChannelRead<R>;
    }
    const waits: Promise<unknown>[] = [];
    for (const reader of readers) {
      reader.pending ??= reader.iterator.next().then(
        (next) => {
          reader.landed.push(next);
          reader.pending = undefined;
        },
        (error: unknown) => {
          reader.failure = { error };
          reader.pending = undefined;
        },
      );
      waits.push(reader.pending);
    }
    if (tagged !== undefined) waits.push(tagged);
    const settled = await Promise.race(waits);
    if (isExtra(settled)) return settled[EXTRA] as X;
  }
}

function isExtra(value: unknown): value is { readonly [EXTRA]: unknown } {
  return typeof value === "object" && value !== null && EXTRA in value;
}
