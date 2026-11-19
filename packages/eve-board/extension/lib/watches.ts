import { createHash } from "node:crypto";

import {
  BOARD_MAX_LEASE_SECONDS,
  boardErrorCode,
  type BoardCan,
  type BoardClaimedTask,
  type BoardClient,
  type BoardDiscovery,
  type BoardMessage,
  type BoardRegistration,
  type BoardRegistrationInput,
} from "./client.ts";

export const DEFAULT_WATCH_CHANNEL = "eve-config/watches";
export const BOARD_ROUTE_BASE = "/board";
export const BOARD_WAKE_ROUTE = `${BOARD_ROUTE_BASE}/wake`;
export const MAX_WATCHES = 32;

const WATCH_LABEL = "eve-watch";
const ACTION_LABEL = "eve-watch-action";
const QUEUE_LABEL = "eve-watch-queue";
const STATE_LABEL = "eve-watch-state";
const LOCK_LABEL = "eve-lock";
const LOCK_LEASE_SECONDS = 30;
const LOCK_WAIT_MS = 30_000;

type Env = Readonly<Record<string, string | undefined>>;

/** Which ready tasks a claiming watch takes: a channel or `prefix/` subtree, labels, and owners by principal ID. */
export interface BoardQueue {
  readonly channel: string;
  readonly label?: Readonly<Record<string, string>>;
  readonly from?: readonly string[];
}

/** What a watch does when it matches: start a turn on the matching thread, or claim a ready task first. */
export type BoardWatchAction =
  | { readonly type: "converse" }
  | { readonly type: "claim"; readonly queue: BoardQueue };

/** A watch: what it matches, and, when its instructions were read, what it does. */
export interface BoardWatch {
  readonly id: string;
  readonly tail: string;
  readonly instructions?: string;
  readonly action?: BoardWatchAction;
  readonly problem?: string;
}

export interface BoardWatchRecord {
  readonly id: string;
  readonly instructions: string;
  readonly action: BoardWatchAction;
  readonly retired: boolean;
  readonly message: BoardMessage;
}

export class BoardWatchConfigError extends Error {
  override readonly name = "BoardWatchConfigError";
}

export function watchIdOf(sessionId: string, callId: string): string {
  const digest = createHash("sha256").update(`${sessionId}:${callId}`).digest();
  return `w-${digest.readBigUInt64BE().toString(36).padStart(6, "0").slice(0, 6)}`;
}

export function publicBoardRoute(route: string, env: Env = process.env): string {
  const prefix = env.EVE_PUBLIC_ROUTE_PREFIX?.trim().replace(/\/+$/u, "") ?? "";
  if (prefix.length === 0) return route;
  return `${prefix.startsWith("/") ? prefix : `/${prefix}`}${route}`;
}

export function hostedEnvironment(env: Env = process.env): "production" | "preview" | undefined {
  const target = env.VERCEL_ENV;
  return target === "production" || target === "preview" ? target : undefined;
}

export function tailChannel(tail: string): string | undefined {
  const args = words(tail);
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    if (arg.includes("=")) continue;
    if (arg === "--mentions") {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-") && (next === "me" || next.includes("@"))) {
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  if (positionals.length > 1) {
    throw new Error(`A watch's tail names one channel; this one names ${positionals.join(", ")}.`);
  }
  return positionals[0];
}

function words(expression: string): string[] {
  const out: string[] = [];
  let word: string | null = null;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < expression.length; i += 1) {
    const char = expression[i]!;
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && i + 1 < expression.length) {
        word = `${word ?? ""}${expression[++i]!}`;
      } else word = `${word ?? ""}${char}`;
    } else if (/\s/u.test(char)) {
      if (word !== null) out.push(word);
      word = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      word ??= "";
    } else word = `${word ?? ""}${char}`;
  }
  if (word !== null) out.push(word);
  return out;
}

function selectorOf(channel: string) {
  return channel.endsWith("/")
    ? { path: channel.slice(0, -1), subtree: true }
    : { path: channel, subtree: false };
}

function covers(pattern: string, channel: string): boolean {
  if (pattern === "*") return true;
  const outer = selectorOf(pattern);
  const inner = selectorOf(channel);
  if (!outer.subtree) return !inner.subtree && inner.path === outer.path;
  return inner.path === outer.path || inner.path.startsWith(`${outer.path}/`);
}

function overlaps(a: string, b: string): boolean {
  return covers(a, b) || covers(b, a);
}

function allows(can: BoardCan | undefined, channel: string, permission: string): boolean {
  if (can === undefined || can === "all") return true;
  if (Array.isArray(can)) return can.includes(permission as never);
  return Object.entries(can as Record<string, "all" | readonly string[]>).some(
    ([pattern, grant]) =>
      covers(pattern, channel) && (grant === "all" || grant.includes(permission)),
  );
}

export function checkWatchScope(input: {
  readonly tail: string;
  readonly action: BoardWatchAction;
  readonly can?: BoardCan;
  readonly watchChannel: string;
}): void {
  const channel = tailChannel(input.tail);
  if (channel === undefined) {
    throw new Error(
      `A watch's tail must name the channel it watches, such as "incidents" or "work/", so it never matches the watch records in "${input.watchChannel}".`,
    );
  }
  if (overlaps(channel, input.watchChannel)) {
    throw new Error(
      `A watch can't cover "${input.watchChannel}", where watch instructions are kept: choose a channel outside it.`,
    );
  }
  if (!allows(input.can, channel, "read")) {
    throw new Error(`This agent may not read "${channel}" on the board, so it can't watch it.`);
  }
  if (input.action.type !== "claim") return;
  const queue = input.action.queue.channel;
  if (overlaps(queue, input.watchChannel)) {
    throw new Error(`A watch can't claim tasks in "${input.watchChannel}".`);
  }
  if (!allows(input.can, queue, "label")) {
    throw new Error(`This agent may not claim tasks in "${queue}" on the board.`);
  }
  for (const owner of input.action.queue.from ?? []) {
    if (owner.includes("+") || !owner.includes(":")) {
      throw new Error(
        `"${owner}" isn't a principal ID: name a task owner such as "vercel:project:prj_abc:production", the part of an actor ID before "+".`,
      );
    }
  }
}

function actionOf(id: string, labels: Readonly<Record<string, string>>): BoardWatchAction {
  const type = labels[ACTION_LABEL] ?? "converse";
  if (type === "converse") return { type };
  if (type !== "claim") {
    throw new BoardWatchConfigError(`Board watch ${id} has an unknown action "${type}".`);
  }
  try {
    const queue = JSON.parse(labels[QUEUE_LABEL] ?? "") as BoardQueue;
    if (typeof queue.channel !== "string" || queue.channel.length === 0) throw new Error();
    return { queue, type };
  } catch {
    throw new BoardWatchConfigError(`Board watch ${id} claims tasks but its queue is unreadable.`);
  }
}

async function recordMessages(
  client: BoardClient,
  watchChannel: string,
  id: string,
): Promise<BoardMessage[]> {
  const found = await client.threads({
    channel: watchChannel,
    label: [`${WATCH_LABEL}=${id}`],
    limit: 2,
  });
  return found.map((summary) => summary.message).filter((message) => !message.deleted);
}

export async function findWatchRecord(input: {
  readonly client: BoardClient;
  readonly watchChannel: string;
  readonly id: string;
  readonly self: { readonly principal: string };
}): Promise<BoardWatchRecord> {
  const { client, id } = input;
  const messages = await recordMessages(client, input.watchChannel, id);
  if (messages.length === 0) {
    throw new BoardWatchConfigError(
      `Board watch ${id} has no instructions in "${input.watchChannel}".`,
    );
  }
  if (messages.length > 1) {
    throw new BoardWatchConfigError(
      `Board watch ${id} has more than one instruction record in "${input.watchChannel}".`,
    );
  }
  const message = messages[0]!;
  if (message.by.principal !== input.self.principal || message.by.profile !== client.profile) {
    throw new BoardWatchConfigError(
      `Board watch ${id}'s instructions were written by ${message.by.actor}, not by this agent.`,
    );
  }
  return {
    action: actionOf(id, message.labels),
    id,
    instructions: message.text,
    message,
    retired: message.labels[STATE_LABEL] === "retired",
  };
}

export function registrationWhere(
  discovery: Pick<BoardDiscovery, "wake_by_path">,
  env: Env = process.env,
): Omit<BoardRegistrationInput, "watch"> {
  const environment = hostedEnvironment(env);
  if (environment === undefined) return { url: null };
  const base = publicBoardRoute(BOARD_ROUTE_BASE, env);
  if (discovery.wake_by_path === true) {
    return {
      branch: environment === "preview" ? (env.VERCEL_GIT_COMMIT_REF ?? null) : null,
      path: base,
      url: null,
    };
  }
  const host =
    environment === "preview" ? env.VERCEL_BRANCH_URL : env.VERCEL_PROJECT_PRODUCTION_URL;
  if (!host) {
    throw new Error(
      `The board doesn't wake by path, and ${environment === "preview" ? "VERCEL_BRANCH_URL" : "VERCEL_PROJECT_PRODUCTION_URL"} is unset, so there's no URL to register.`,
    );
  }
  return { url: `https://${host}${base}` };
}

function whereOf(held: BoardRegistration): Omit<BoardRegistrationInput, "watch"> {
  return held.path ? { branch: held.branch ?? null, path: held.path } : { url: held.url ?? null };
}

export async function heldRegistration(
  client: BoardClient,
): Promise<BoardRegistration | undefined> {
  const [me, registrations] = await Promise.all([client.me(), client.watchers()]);
  return registrations.find((registration) => registration.owner === me.principal);
}

const localLocks = new Map<string, Promise<unknown>>();

async function withRegistrationLock<T>(
  client: BoardClient,
  watchChannel: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = `${client.profile}\n${watchChannel}`;
  const previous = localLocks.get(key) ?? Promise.resolve();
  const turn = previous
    .catch(() => {})
    .then(async () => {
      const claim = await claimLock(client, await lockTask(client, watchChannel));
      try {
        return await run();
      } finally {
        await client
          .held(claim)
          .release()
          .catch(() => {});
      }
    });
  localLocks.set(key, turn);
  try {
    return await turn;
  } finally {
    if (localLocks.get(key) === turn) localLocks.delete(key);
  }
}

async function lockTask(client: BoardClient, watchChannel: string): Promise<string> {
  const found = await client.threads({
    channel: watchChannel,
    label: [`${LOCK_LABEL}=registration`],
    limit: 1,
  });
  if (found[0] !== undefined) return found[0].message.id;
  const created = await client.createTask(watchChannel, {
    id: "eve-watch-lock",
    labels: { [LOCK_LABEL]: "registration" },
    noSync: true,
    text: "eve holds this task while it changes its board watches, so two changes never overwrite each other. Leave it open.",
  });
  return created.id;
}

async function claimLock(client: BoardClient, taskId: string): Promise<BoardClaimedTask> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      return await client.claim(taskId, LOCK_LEASE_SECONDS);
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(
          "Another change to this agent's board watches is still running. Try again in a minute.",
          { cause: error },
        );
      }
      if (boardErrorCode(error) === "not_found") throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 600));
    }
  }
}

async function updateRegistration(input: {
  readonly client: BoardClient;
  readonly watchChannel: string;
  readonly env?: Env;
  change(watch: Record<string, { readonly tail: string }>): boolean;
}): Promise<BoardRegistration | undefined> {
  const { client } = input;
  return await withRegistrationLock(client, input.watchChannel, async () => {
    const held = await heldRegistration(client);
    const watch = { ...held?.watch };
    if (!input.change(watch)) return held;
    const where =
      held === undefined ? registrationWhere(await client.discovery(), input.env) : whereOf(held);
    try {
      return await client.register({ ...where, sync: held?.sync, watch });
    } catch (error) {
      if (boardErrorCode(error) !== "watchers_need_project") throw error;
      throw new Error(
        "Vercel's board takes watches only from a deployment. To try watches locally, run `npx @vercel/board serve` and set BOARD_URL to the URL it prints.",
        { cause: error },
      );
    }
  });
}

export async function createWatch(input: {
  readonly client: BoardClient;
  readonly watchChannel: string;
  readonly id: string;
  readonly tail: string;
  readonly instructions: string;
  readonly action: BoardWatchAction;
  readonly env?: Env;
}): Promise<BoardWatch> {
  const { action, client, id, tail } = input;
  await client.post(input.watchChannel, {
    id: `eve-watch-${id}`,
    labels: {
      [ACTION_LABEL]: action.type,
      [WATCH_LABEL]: id,
      ...(action.type === "claim" && { [QUEUE_LABEL]: JSON.stringify(action.queue) }),
    },
    noSync: true,
    text: input.instructions,
  });
  await updateRegistration({
    client,
    env: input.env,
    watchChannel: input.watchChannel,
    change(watch) {
      if (watch[id] === undefined && Object.keys(watch).length >= MAX_WATCHES) {
        throw new Error(
          `This agent already has ${MAX_WATCHES} board watches, the most one deployment can register. Remove one first.`,
        );
      }
      watch[id] = { tail };
      return true;
    },
  });
  return { action, id, instructions: input.instructions, tail };
}

export async function listWatches(input: {
  readonly client: BoardClient;
  readonly watchChannel: string;
  readonly details: boolean;
}): Promise<BoardWatch[]> {
  const { client } = input;
  const held = await heldRegistration(client);
  const entries = Object.entries(held?.watch ?? {});
  if (!input.details) return entries.map(([id, { tail }]) => ({ id, tail }));
  const self = await client.me();
  return await Promise.all(
    entries.map(async ([id, { tail }]): Promise<BoardWatch> => {
      try {
        const record = await findWatchRecord({
          client,
          id,
          self,
          watchChannel: input.watchChannel,
        });
        return { action: record.action, id, instructions: record.instructions, tail };
      } catch (error) {
        return { id, problem: (error as Error).message, tail };
      }
    }),
  );
}

export async function removeWatch(input: {
  readonly client: BoardClient;
  readonly watchChannel: string;
  readonly id: string;
  readonly env?: Env;
}): Promise<{ readonly id: string; readonly removed: boolean }> {
  const { client, id } = input;
  let removed = false;
  await updateRegistration({
    client,
    env: input.env,
    watchChannel: input.watchChannel,
    change(watch) {
      removed = watch[id] !== undefined;
      delete watch[id];
      return removed;
    },
  });
  const self = await client.me();
  for (const message of await recordMessages(client, input.watchChannel, id)) {
    if (message.by.principal !== self.principal || message.by.profile !== client.profile) continue;
    await client.label(message.id, { set: { [STATE_LABEL]: "retired" } });
  }
  return { id, removed };
}

export const CLAIM_LEASE_SECONDS = BOARD_MAX_LEASE_SECONDS;
