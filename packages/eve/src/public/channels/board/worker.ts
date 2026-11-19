import { createLogger, logError } from "#internal/logging.js";
import {
  BOARD_MAX_LEASE_SECONDS,
  boardErrorCode,
  type BoardClaim,
  type BoardClaimedTask,
  type BoardClient,
} from "#public/channels/board/client.js";

const log = createLogger("board.worker");

export const BOARD_WORKER_WATCHER = "worker";

const MAX_CONCURRENCY = 50;
const LABEL_KEY = /^[A-Za-z0-9_.:/-]{1,64}$/u;
const LABEL_VALUE = /^[^\s"'\\]{1,200}$/u;
const SETTLEMENTS = new Set(["completed", "failed", "blocked", "released"]);

/**
 * Which tasks the agent claims from the board's queue. Each claim starts or continues a session on
 * the task's thread, and the board never gives one task to two holders at once.
 */
export interface BoardWorker {
  /** The channel, or a subtree such as `"work/"`, the agent claims ready tasks from. */
  readonly channel: string;
  /** Labels a task must have, such as `{ role: "review" }`. */
  readonly label?: Readonly<Record<string, string>>;
  /**
   * Owners, by actor ID, whose tasks the agent may take, such as a planner's. Without them it
   * takes only tasks its own deployment created: a task's text is instructions to whoever claims it.
   */
  readonly from?: readonly string[];
  /** How many tasks the agent holds at once. Defaults to 1. */
  readonly concurrency?: number;
  /** Each claim's lease in seconds, renewed while the agent works. At most and by default 300. */
  readonly lease?: number;
  /** Added before every turn on a claimed task, such as how to work the queue. */
  readonly context?: readonly string[];
}

/**
 * A task claim a worker session holds: what renews and settles it. `token` proves the claim; the
 * board still checks the deployment's own credentials on every write it makes.
 */
export interface BoardHeldClaim {
  readonly id: string;
  readonly epoch: number;
  readonly token: string;
  readonly until: string;
  readonly lease: number;
}

export interface ResolvedBoardWorker {
  readonly channel: string;
  readonly label: Readonly<Record<string, string>>;
  readonly from: readonly string[];
  readonly concurrency: number;
  readonly lease: number;
  readonly context: readonly string[];
  readonly tail: string;
}

export function resolveBoardWorker(worker: BoardWorker): ResolvedBoardWorker {
  const channel = worker.channel.trim();
  if (channel.length === 0 || /\s/u.test(channel)) {
    throw new Error(
      `Board worker channel "${worker.channel}" is invalid: name one channel or subtree, such as "work/".`,
    );
  }
  const label = { ...worker.label };
  for (const [key, value] of Object.entries(label)) {
    if (!LABEL_KEY.test(key) || !LABEL_VALUE.test(value)) {
      throw new Error(
        `Board worker label ${key}=${value} is invalid: use a key and value without spaces or quotes.`,
      );
    }
  }
  const concurrency = worker.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(
      `Board worker concurrency must be a whole number from 1 to ${MAX_CONCURRENCY}; got ${concurrency}.`,
    );
  }
  const lease = worker.lease ?? BOARD_MAX_LEASE_SECONDS;
  if (!Number.isInteger(lease) || lease < 30 || lease > BOARD_MAX_LEASE_SECONDS) {
    throw new Error(
      `Board worker lease must be a whole number of seconds from 30 to ${BOARD_MAX_LEASE_SECONDS}; got ${lease}.`,
    );
  }
  return {
    channel,
    concurrency,
    context: worker.context ?? [],
    from: worker.from ?? [],
    label,
    lease,
    tail: [channel, ...Object.entries(label).map(([key, value]) => `--label ${key}=${value}`)].join(
      " ",
    ),
  };
}

export function heldClaimOf(claim: BoardClaimedTask, lease: number): BoardHeldClaim {
  return { epoch: claim.epoch, id: claim.taskId, lease, token: claim.token, until: claim.until };
}

export function boardClaimOf(claim: BoardHeldClaim): BoardClaim {
  return { epoch: claim.epoch, taskId: claim.id, token: claim.token, until: claim.until };
}

const dispatching = new Map<string, Promise<unknown>>();

export async function dispatchWork(input: {
  readonly client: BoardClient;
  readonly worker: ResolvedBoardWorker;
  readonly self: { readonly actor: string };
  readonly deliver: (claim: BoardClaimedTask) => Promise<void>;
}): Promise<number> {
  const key = `${input.self.actor}\n${input.worker.channel}`;
  const previous = dispatching.get(key) ?? Promise.resolve();
  const pass = previous.catch(() => {}).then(() => claimUpToCapacity(input));
  dispatching.set(key, pass);
  try {
    return await pass;
  } finally {
    if (dispatching.get(key) === pass) dispatching.delete(key);
  }
}

async function claimUpToCapacity(input: {
  readonly client: BoardClient;
  readonly worker: ResolvedBoardWorker;
  readonly self: { readonly actor: string };
  readonly deliver: (claim: BoardClaimedTask) => Promise<void>;
}): Promise<number> {
  const { client, worker } = input;
  const now = Date.now();
  const holding = (await client.claimedTasks(worker.channel)).filter((task) => {
    const claim = task.task?.claim;
    return claim?.actor === input.self.actor && Date.parse(claim.until) > now;
  }).length;
  let started = 0;
  for (let free = worker.concurrency - holding; free > 0; free -= 1) {
    const claim = await client.claimReady({
      channel: worker.channel,
      from: worker.from,
      label: worker.label,
      lease: worker.lease,
    });
    if (claim === null) break;
    try {
      await input.deliver(claim);
    } catch (error) {
      await client
        .held(claim)
        .release()
        .catch((releaseError) =>
          logError(log, "board task release failed", releaseError, { task: claim.taskId }),
        );
      throw error;
    }
    started += 1;
  }
  return started;
}

export function claimDue(claim: BoardHeldClaim, now = Date.now()): boolean {
  return Date.parse(claim.until) - now < (claim.lease * 1000) / 3;
}

export async function renewClaim(
  client: BoardClient,
  claim: BoardHeldClaim,
): Promise<BoardHeldClaim | null> {
  try {
    const renewed = await client.held(boardClaimOf(claim)).renew(claim.lease);
    return { ...claim, epoch: renewed.epoch, token: renewed.token, until: renewed.until };
  } catch (error) {
    if (boardErrorCode(error) !== "claim_lost") throw error;
    log.warn("board task claim was lost; the agent no longer holds the task", { task: claim.id });
    return null;
  }
}

const UNSETTLED_REASONS: Readonly<Record<string, string>> = {
  cancelled: "The agent's turn was cancelled before it settled this task.",
  completed: "The agent's turn ended without settling this task.",
  ended: "The agent's session ended before it settled this task.",
};

export async function holdUnsettled(
  client: BoardClient,
  claim: BoardHeldClaim,
  outcome: string,
): Promise<void> {
  const reason =
    UNSETTLED_REASONS[outcome] ?? "The agent's turn failed before it settled this task.";
  try {
    await client.held(boardClaimOf(claim)).block(reason, { kind: "unsettled" });
  } catch (error) {
    if (boardErrorCode(error) !== "claim_lost") throw error;
  }
}

export function taskSettlementOf(output: unknown): { readonly task: string } | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const { settled, task } = output as { readonly settled?: unknown; readonly task?: unknown };
  return typeof settled === "string" && SETTLEMENTS.has(settled) && typeof task === "string"
    ? { task }
    : undefined;
}
