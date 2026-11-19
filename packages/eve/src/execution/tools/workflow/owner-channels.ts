export interface ChannelReader<C extends string, T> {
  readonly channel: C;
  readonly iterator: AsyncIterator<T>;
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

type ChannelReadResult<R> =
  R extends ChannelReader<infer C, infer T>
    ? { readonly channel: C; readonly next: IteratorResult<T> }
    : never;

type ChannelRead<R extends readonly ChannelReader<string, unknown>[]> = ChannelReadResult<
  R[number]
>;

export function raceChannelReads<const R extends readonly ChannelReader<string, unknown>[]>(
  readers: R,
): Promise<ChannelRead<R>>;
export function raceChannelReads<const R extends readonly ChannelReader<string, unknown>[]>(
  readers: R,
  cancelled: Promise<"cancel"> | undefined,
): Promise<ChannelRead<R> | "cancel">;
export async function raceChannelReads<const R extends readonly ChannelReader<string, unknown>[]>(
  readers: R,
  cancelled?: Promise<"cancel">,
): Promise<ChannelRead<R> | "cancel"> {
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
    if (cancelled !== undefined) waits.push(cancelled);
    if ((await Promise.race(waits)) === "cancel") return "cancel";
  }
}
