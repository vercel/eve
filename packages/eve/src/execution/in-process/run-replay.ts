import { runMessagesIn } from "#execution/tools/workflow/messages.js";

// A run that goes on after a restore runs its body from the start, so it must reach where it
// was: what its hooks received before arrives again, in the order it did, each once the run got
// as far as it had then (as far as the messages it had sent its session, with the hook open);
// and what its session already heard from it isn't sent again. A new run has nothing to replay.

/** One payload a run's hook received, as its journal keeps it. */
export interface ReceivedPayload {
  readonly token: string;
  readonly payload: unknown;
  /** How many messages the run had sent its session when it arrived. */
  readonly afterSent: number;
}

/** What a run that goes on did before: what its hooks received, and how much its session heard. */
export interface EarlierRun {
  readonly received: readonly ReceivedPayload[];
  /** How many of its messages its session heard. */
  readonly heard: number;
}

export class RunReplay {
  private readonly pending: ReceivedPayload[];
  private readonly heard: number;
  private readonly openHooks = new Set<string>();
  private readonly deliver: (token: string, payload: unknown) => Promise<void>;
  private releasing: Promise<void> = Promise.resolve();
  /** How many messages the run sent its session, before the restore and since. */
  private sentSoFar = 0;

  /** Replays `earlier` to the run's hooks through `deliver`, which doesn't keep it again. */
  constructor(earlier: EarlierRun, deliver: (token: string, payload: unknown) => Promise<void>) {
    this.pending = [...earlier.received];
    this.heard = earlier.heard;
    this.deliver = deliver;
  }

  /** How many messages the run sent its session so far, which its journal stamps arrivals with. */
  get sent(): number {
    return this.sentSoFar;
  }

  /** The run opened its hook `token`: what it received there before can arrive. */
  opened(token: string): Promise<void> {
    this.openHooks.add(token);
    return this.release();
  }

  /**
   * The run sends its session `payload`. `false` when the session heard it before the restore,
   * so it isn't sent again.
   */
  send(payload: unknown): boolean {
    const heardAlready = this.sentSoFar < this.heard;
    this.sentSoFar += runMessagesIn(payload).length;
    void this.release();
    return !heardAlready;
  }

  private release(): Promise<void> {
    this.releasing = this.releasing.then(async () => {
      while (true) {
        const [next] = this.pending;
        if (
          next === undefined ||
          next.afterSent > this.sentSoFar ||
          !this.openHooks.has(next.token)
        )
          return;
        this.pending.shift();
        await this.deliver(next.token, next.payload);
      }
    });
    return this.releasing;
  }
}
