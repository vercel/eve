import { createHash } from "node:crypto";

import { publicRoutePath } from "eve/channels";

import { DEFAULT_BOARD_KEY, DEFAULT_WATCH_CHANNEL } from "./boards.ts";
import {
  BOARD_CHANNEL_SELECTOR,
  BOARD_TAIL_LIMIT,
  BOARD_TEXT_LIMIT,
  BOARD_NAME_PATTERN,
  boardAllows,
  boardErrorCode,
  createBoardClient,
  type BoardCan,
  type BoardClaimedTask,
  type BoardClient,
  type BoardDiscovery,
  type BoardMessage,
  type BoardPermission,
  type BoardRegistration,
  type BoardRegistrationInput,
  type BoardSettings,
} from "./client.ts";
import {
  BOARD_WAKE_ROUTE,
  DEFAULT_BOARD_ROUTE_BASE,
  LEGACY_BOARD_WAKE_ROUTE,
  normalizeBoardRouteBase,
} from "./route.ts";

export {
  BOARD_WAKE_ROUTE,
  DEFAULT_BOARD_ROUTE_BASE,
  DEFAULT_WATCH_CHANNEL,
  LEGACY_BOARD_WAKE_ROUTE,
};
export const MAX_WATCHES = 32;

const WATCH_LABEL = "eve-watch";
const STATE_LABEL = "eve-watch-state";
const LOCK_LABEL = "eve-lock";
const LOCK_LEASE_SECONDS = 30;
const LOCK_WAIT_MS = 30_000;

export interface BoardQueue {
  readonly channel: string;
  readonly label?: Readonly<Record<string, string>>;
  readonly from?: readonly string[];
}

export type BoardWatchAction =
  | { readonly type: "converse" }
  | { readonly type: "claim"; readonly queue: BoardQueue };

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

export interface BoardWatchFilter {
  readonly channel: string;
  readonly label?: readonly string[];
  readonly by?: string;
  readonly text?: string;
}

const quoted = (value: string) => `"${value.replace(/["\\]/gu, "\\$&")}"`;

export function tailOf({ channel, label = [], by, text }: BoardWatchFilter): string {
  return [
    channel,
    ...label.map((value) => `--label=${quoted(value)}`),
    ...(by === undefined ? [] : [`--by=${quoted(by)}`]),
    ...(text === undefined ? [] : [`--text=${quoted(text)}`]),
  ].join(" ");
}

function selectorOf(channel: string) {
  return channel.endsWith("/")
    ? { path: channel.slice(0, -1), subtree: true }
    : { path: channel, subtree: false };
}

export function coversChannel(pattern: string, channel: string): boolean {
  if (pattern === "*") return true;
  const outer = selectorOf(pattern);
  const inner = selectorOf(channel);
  if (!outer.subtree) return !inner.subtree && inner.path === outer.path;
  return inner.path === outer.path || inner.path.startsWith(`${outer.path}/`);
}

function overlaps(a: string, b: string): boolean {
  return coversChannel(a, b) || coversChannel(b, a);
}

function assertChannelSelector(channel: string): void {
  if (!BOARD_CHANNEL_SELECTOR.test(channel)) {
    throw new Error(
      `"${channel}" isn't a board channel: use lowercase segments joined by "/", such as "incidents" or "www/production", and end it with "/" to cover a subtree.`,
    );
  }
}

export function assertWatchId(id: string): void {
  if (!BOARD_NAME_PATTERN.test(id)) {
    throw new Error(`"${id}" isn't a board watch ID: watch IDs look like "w-7k3p2q".`);
  }
}

function modelCan(can: BoardCan | undefined, watchChannel: string): BoardCan {
  const grants: Record<string, "all" | readonly BoardPermission[]> =
    can === undefined || can === "all"
      ? { "*": "all" }
      : Array.isArray(can)
        ? { "*": can as readonly BoardPermission[] }
        : { ...(can as Record<string, "all" | readonly BoardPermission[]>) };
  grants[watchChannel] = boardAllows(can, watchChannel, "read") ? ["read"] : [];
  return grants;
}

export type BoardClientConfig = Pick<
  BoardSettings,
  "can" | "name" | "profile" | "team" | "url" | "watchChannel"
>;

export function boardClients(settings: BoardClientConfig) {
  const watchChannel = settings.watchChannel ?? DEFAULT_WATCH_CHANNEL;
  return {
    deployment: createBoardClient(settings),
    model: createBoardClient(settings, modelCan(settings.can, watchChannel)),
    watchChannel,
  };
}

export function checkWatchScope(input: {
  readonly channel: string;
  readonly action: BoardWatchAction;
  readonly can?: BoardCan;
  readonly watchChannel: string;
}): void {
  const { channel } = input;
  assertChannelSelector(channel);
  if (overlaps(channel, input.watchChannel)) {
    throw new Error(
      `A watch can't cover "${input.watchChannel}", where watch instructions are kept: choose a channel outside it.`,
    );
  }
  if (!boardAllows(input.can, channel, "read")) {
    throw new Error(`This agent may not read "${channel}" on the board, so it can't watch it.`);
  }
  if (input.action.type === "claim") checkQueueScope(input.action.queue, input);
}

export function checkQueueScope(
  queue: BoardQueue,
  input: { readonly can?: BoardCan; readonly watchChannel: string },
): void {
  assertChannelSelector(queue.channel);
  if (overlaps(queue.channel, input.watchChannel)) {
    throw new Error(`A watch can't claim tasks in "${input.watchChannel}".`);
  }
  if (!boardAllows(input.can, queue.channel, "label")) {
    throw new Error(`This agent may not claim tasks in "${queue.channel}" on the board.`);
  }
  for (const owner of queue.from ?? []) {
    if (owner.includes("+") || !owner.includes(":")) {
      throw new Error(
        `"${owner}" isn't a principal ID: name a task owner such as "vercel:project:prj_abc:production", the part of an actor ID before "+".`,
      );
    }
  }
}

const HEADER = /\n*```eve-watch\n([^\n]*)\n```\s*$/u;

export function watchRecordText(
  id: string,
  action: BoardWatchAction,
  instructions: string,
): string {
  return `${instructions.trim()}\n\n\`\`\`eve-watch\n${JSON.stringify({ action, id })}\n\`\`\``;
}

function parseRecord(id: string, text: string) {
  const header = HEADER.exec(text);
  let parsed: { readonly id?: unknown; readonly action?: BoardWatchAction } | undefined;
  try {
    parsed = header === null ? undefined : JSON.parse(header[1]!);
  } catch {
    parsed = undefined;
  }
  if (parsed?.id !== id) {
    throw new BoardWatchConfigError(`Board watch ${id}'s instruction record doesn't name it.`);
  }
  const action = parsed.action;
  const valid =
    action?.type === "converse" ||
    (action?.type === "claim" &&
      typeof action.queue?.channel === "string" &&
      action.queue.channel.length > 0);
  if (!valid) {
    throw new BoardWatchConfigError(`Board watch ${id}'s instruction record has no valid action.`);
  }
  return { action: action!, instructions: text.slice(0, header!.index).trim() };
}

async function labeledRoots(
  client: BoardClient,
  watchChannel: string,
  label: string,
  limit: number,
): Promise<BoardMessage[]> {
  const found = await client.threads({ channel: watchChannel, label: [label], limit });
  return found.map((summary) => summary.message).filter((message) => !message.deleted);
}

function recordMessages(
  client: BoardClient,
  watchChannel: string,
  id: string,
): Promise<BoardMessage[]> {
  return labeledRoots(client, watchChannel, `${WATCH_LABEL}=${id}`, 2);
}

export async function findWatchRecord(input: {
  readonly client: BoardClient;
  readonly watchChannel: string;
  readonly id: string;
  readonly self: { readonly actor: string };
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
  if (message.by.actor !== input.self.actor) {
    throw new BoardWatchConfigError(
      `Board watch ${id}'s instructions were written by ${message.by.actor}, not by this agent.`,
    );
  }
  const { action, instructions } = parseRecord(id, message.text);
  return {
    action,
    id,
    instructions,
    message,
    retired: message.labels[STATE_LABEL] === "retired",
  };
}

export function registrationWhere(
  discovery: Pick<BoardDiscovery, "wake_by_path">,
  routeBase = DEFAULT_BOARD_ROUTE_BASE,
): Omit<BoardRegistrationInput, "watch"> {
  const { env } = process;
  const environment = env.VERCEL_ENV;
  if (environment !== "production" && environment !== "preview") return { url: null };
  const base = publicRoutePath(normalizeBoardRouteBase(routeBase));
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
  boardKey: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = `${boardKey}\n${client.profile}\n${watchChannel}`;
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
  const self = await client.me();
  const found = await labeledRoots(client, watchChannel, `${LOCK_LABEL}=registration`, 20);
  const lock = found.find((message) => message.by.actor === self.actor);
  if (lock !== undefined) {
    const state = lock.task?.state;
    if (state !== "ready" && state !== "claimed") {
      throw new Error(
        `The board task that serializes this agent's watch changes, #${lock.id} in "${watchChannel}", is ${state ?? "not a task"}. Reopen it so watches can change again.`,
      );
    }
    return lock.id;
  }
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
      if (boardErrorCode(error) !== "task_claimed") throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          "Another change to this agent's board watches is still running. Try again in a minute.",
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 600));
    }
  }
}

function isVercelDeployment(): boolean {
  const environment = process.env.VERCEL_ENV;
  return environment === "production" || environment === "preview";
}

function registrationDestinationChanged(
  held: BoardRegistration | undefined,
  desired: Omit<BoardRegistrationInput, "watch">,
): boolean {
  if (held === undefined) return false;
  return (
    (held.path ?? null) !== (desired.path ?? null) ||
    (held.branch ?? null) !== (desired.branch ?? null) ||
    (held.url ?? null) !== (desired.url ?? null)
  );
}

async function updateRegistration(input: {
  readonly boardKey?: string;
  readonly client: BoardClient;
  readonly routeBase?: string;
  readonly watchChannel: string;
  change(watch: Record<string, { readonly tail: string }>): boolean;
}): Promise<BoardRegistration | undefined> {
  const { client } = input;
  return await withRegistrationLock(
    client,
    input.watchChannel,
    input.boardKey ?? DEFAULT_BOARD_KEY,
    async () => {
      const held = await heldRegistration(client);
      const watch = { ...held?.watch };
      const watchChanged = input.change(watch);
      const deployed = isVercelDeployment();
      const desired = deployed
        ? registrationWhere(await client.discovery(), input.routeBase)
        : undefined;
      const destinationChanged =
        desired !== undefined && registrationDestinationChanged(held, desired);
      if (!watchChanged && !destinationChanged) return held;
      const where =
        desired ??
        (held !== undefined
          ? {
              branch: held.branch ?? null,
              path: held.path ?? null,
              url: held.url ?? null,
            }
          : registrationWhere(await client.discovery(), input.routeBase));
      try {
        return await client.register({
          ...where,
          ...(held?.sync !== undefined && { sync: held.sync }),
          watch,
        });
      } catch (error) {
        if (boardErrorCode(error) !== "watchers_need_project") throw error;
        throw new Error(
          "Vercel's board takes watches only from a deployment. To try watches locally, run `npx @vercel/board serve` and set BOARD_URL to the URL it prints.",
          { cause: error },
        );
      }
    },
  );
}

export async function createWatch(input: {
  readonly boardKey?: string;
  readonly client: BoardClient;
  readonly watchChannel: string;
  readonly id: string;
  readonly tail: string;
  readonly instructions: string;
  readonly action: BoardWatchAction;
  readonly routeBase?: string;
}): Promise<BoardWatch> {
  const { action, client, id, tail } = input;
  const text = watchRecordText(id, action, input.instructions);
  if (text.length > BOARD_TEXT_LIMIT) {
    throw new Error(
      `These watch instructions are too long to store: shorten them by ${text.length - BOARD_TEXT_LIMIT} characters.`,
    );
  }
  if (tail.length > BOARD_TAIL_LIMIT) {
    throw new Error(
      `This watch's filters are too long for the board: shorten them by ${tail.length - BOARD_TAIL_LIMIT} characters.`,
    );
  }
  const held = await heldRegistration(client);
  if (held?.watch[id] === undefined && Object.keys(held?.watch ?? {}).length >= MAX_WATCHES) {
    throw tooManyWatches();
  }
  const record = await client.post(input.watchChannel, {
    id: `eve-watch-${id}`,
    labels: { [WATCH_LABEL]: id },
    noSync: true,
    text,
  });
  try {
    await updateRegistration({
      boardKey: input.boardKey,
      client,
      routeBase: input.routeBase,
      watchChannel: input.watchChannel,
      change(watch) {
        if (watch[id] === undefined && Object.keys(watch).length >= MAX_WATCHES) {
          throw tooManyWatches();
        }
        watch[id] = { tail };
        return true;
      },
    });
  } catch (error) {
    const now = await heldRegistration(client).catch(() => held);
    if (now?.watch[id] === undefined) {
      await client.label(record.id, { set: { [STATE_LABEL]: "retired" } }).catch(() => undefined);
    }
    throw error;
  }
  if (record.labels[STATE_LABEL] !== undefined) {
    await client.label(record.id, { unset: [STATE_LABEL] });
  }
  return { action, id, instructions: input.instructions, tail };
}

function tooManyWatches(): Error {
  return new Error(
    `This agent already has ${MAX_WATCHES} board watches, the most one deployment can register. Remove one first.`,
  );
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
        if (record.retired) {
          return {
            id,
            problem: `Board watch ${id}'s instructions are retired, so it never fires. Remove it with unwatch and create it again.`,
            tail,
          };
        }
        return { action: record.action, id, instructions: record.instructions, tail };
      } catch (error) {
        return { id, problem: (error as Error).message, tail };
      }
    }),
  );
}

export async function removeWatch(input: {
  readonly boardKey?: string;
  readonly client: BoardClient;
  readonly watchChannel: string;
  readonly id: string;
  readonly routeBase?: string;
}): Promise<{ readonly id: string; readonly removed: boolean }> {
  const { client, id } = input;
  assertWatchId(id);
  let removed = false;
  await updateRegistration({
    boardKey: input.boardKey,
    client,
    routeBase: input.routeBase,
    watchChannel: input.watchChannel,
    change(watch) {
      removed = watch[id] !== undefined;
      delete watch[id];
      return removed;
    },
  });
  const self = await client.me();
  for (const message of await recordMessages(client, input.watchChannel, id)) {
    if (message.by.actor !== self.actor) continue;
    await client.label(message.id, { set: { [STATE_LABEL]: "retired" } });
  }
  return { id, removed };
}
