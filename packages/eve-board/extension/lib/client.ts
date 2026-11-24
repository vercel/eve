import { createHash } from "node:crypto";

import type extension from "../extension.ts";

import {
  board as boardHandle,
  type Board as BoardHandle,
  type MatchView,
  type MessageView,
  type ScheduleView,
  type Written,
} from "@vercel/board";
import { compileAccess, type Can } from "@vercel/board/access";

export interface BoardAuthor {
  readonly actor: string;
  readonly principal: string;
  readonly profile: string | null;
}

export interface BoardActor {
  readonly kind: string;
  readonly handle: string;
  readonly name: string;
}

export interface BoardAttachment {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

export interface BoardTaskState {
  readonly state: string;
  readonly owner: string;
  readonly claim: { readonly actor: string; readonly until: string } | null;
  readonly blocked: { readonly kind: string | null; readonly reason: string } | null;
  readonly result: string | null;
  readonly reason: string | null;
}

export interface BoardMessage {
  readonly id: string;
  readonly channel: string;
  readonly text: string;
  readonly re: string | null;
  readonly thread: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly by: BoardAuthor;
  readonly author: BoardActor | null;
  readonly attachments: readonly BoardAttachment[];
  readonly createdAt: string;
  readonly deleted: boolean;
  readonly noSync: boolean;
  readonly schedule?: { readonly id: string; readonly n: number };
  readonly task?: BoardTaskState;
}

export interface BoardWrittenMessage extends BoardMessage {
  readonly unknownMentions?: readonly string[];
}

export interface BoardThread {
  readonly message: BoardMessage;
  readonly replies: readonly BoardMessage[];
}

export interface BoardThreadSummary {
  readonly message: BoardMessage;
  readonly replies: number;
  readonly last: BoardMessage | null;
}

export interface BoardChannelSummary {
  readonly path: string;
}

export interface BoardThreadsQuery {
  readonly channel?: string;
  readonly label?: readonly string[];
  readonly after?: string;
  readonly before?: string;
  readonly limit?: number;
}

export interface BoardThreadsPage {
  readonly threads: readonly BoardThreadSummary[];
  readonly cursor: string;
  readonly older: string | null;
}

export interface BoardActorSummary {
  readonly id: string;
  readonly handle: string;
  readonly name: string;
  readonly kind: string;
}

export interface BoardPostOptions {
  readonly text: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly noSync?: boolean;
  readonly id?: string;
  readonly attachments?: readonly string[];
  readonly after?: string;
}

export interface BoardScheduleOptions {
  readonly text: string;
  readonly noSync?: boolean;
  readonly in?: string;
  readonly at?: string;
  readonly every?: string;
  readonly times?: number;
  readonly until?: string;
}

export interface BoardSchedule {
  readonly id: string;
  readonly channel: string;
  readonly re: string | null;
  readonly text: string;
  readonly next: string | null;
  readonly state: string;
}

export interface BoardClaim {
  readonly taskId: string;
  readonly epoch: number;
  readonly token: string;
  readonly until: string;
}

export interface BoardClaimedTask extends BoardClaim {
  readonly task: BoardMessage;
}

export interface BoardHeldTask {
  renew(lease?: number): Promise<string>;
  release(): Promise<void>;
  complete(result?: string): Promise<void>;
  fail(reason: string): Promise<void>;
  block(reason: string, options?: { readonly kind?: string }): Promise<void>;
}

export interface BoardReadyTaskQuery {
  readonly channel: string;
  readonly label?: Readonly<Record<string, string>>;
  readonly from?: readonly string[];
  readonly lease?: number;
}

export interface BoardNewTask {
  readonly text: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly needs?: readonly string[];
  readonly noSync?: boolean;
  readonly id?: string;
}

export interface BoardEvent {
  readonly cursor: string;
  readonly type: string;
  readonly createdAt: string;
  readonly message?: BoardMessage;
}

export interface BoardMatch {
  readonly id: string;
  readonly watcher: string;
  readonly lease: string;
  readonly attempt: number;
  readonly event: BoardEvent;
}

export interface BoardSyncEntry {
  readonly key: string;
  readonly platform: string;
}

export interface BoardRegistrationInput {
  readonly url?: string | null;
  readonly path?: string | null;
  readonly branch?: string | null;
  readonly watch: Readonly<Record<string, { readonly tail: string }>>;
  readonly sync?: readonly BoardSyncEntry[];
}

export interface BoardRegistration extends BoardRegistrationInput {
  readonly owner: string;
  readonly hash: string;
}

export interface BoardDiscovery {
  readonly url: string;
  readonly wake_by_path?: boolean;
}

export type BoardCan =
  | "all"
  | readonly BoardPermission[]
  | Readonly<Record<string, "all" | readonly BoardPermission[]>>;

export const BOARD_PERMISSIONS = ["read", "post", "react", "label", "sync", "manage"] as const;

export type BoardPermission = (typeof BOARD_PERMISSIONS)[number];

export interface BoardClient {
  readonly profile: string;
  discovery(): Promise<BoardDiscovery>;
  me(): Promise<{ readonly principal: string; readonly actor: string }>;
  watchers(): Promise<readonly BoardRegistration[]>;
  register(input: BoardRegistrationInput): Promise<BoardRegistration>;
  matches(options?: {
    readonly limit?: number;
    readonly wait?: number;
  }): Promise<readonly BoardMatch[]>;
  ack(
    match: BoardMatch,
    outcome?: { readonly error?: string; readonly skip?: boolean },
  ): Promise<void>;
  post(channel: string, options: BoardPostOptions): Promise<BoardWrittenMessage>;
  reply(id: string, options: BoardPostOptions): Promise<BoardWrittenMessage>;
  upload(file: {
    readonly data: Uint8Array;
    readonly name: string;
    readonly type?: string;
  }): Promise<BoardAttachment>;
  react(id: string, emoji: string, options?: { readonly remove?: boolean }): Promise<void>;
  label(
    id: string,
    change: {
      readonly set?: Record<string, string>;
      readonly unset?: readonly string[];
      readonly if?: Readonly<Record<string, string | null>>;
    },
  ): Promise<void>;
  typing(id: string, status?: string): Promise<void>;
  thread(id: string, range?: { readonly after?: string }): Promise<BoardThread>;
  linked(url: string): Promise<BoardThread>;
  threads(query?: BoardThreadsQuery): Promise<readonly BoardThreadSummary[]>;
  threadsPage(query?: BoardThreadsQuery): Promise<BoardThreadsPage>;
  schedules(query?: {
    readonly re?: string;
    readonly channel?: string;
    readonly by?: string;
  }): Promise<readonly BoardSchedule[]>;
  actors(): Promise<readonly BoardActorSummary[]>;
  channels(): Promise<readonly BoardChannelSummary[]>;
  download(attachmentId: string): Promise<Response>;
  schedule(
    target: { readonly re: string } | { readonly channel: string },
    options: BoardScheduleOptions,
  ): Promise<BoardSchedule>;
  cancelSchedule(id: string): Promise<{ readonly canceled: boolean }>;
  claimReady(query: BoardReadyTaskQuery): Promise<BoardClaimedTask | null>;
  claim(taskId: string, lease?: number): Promise<BoardClaimedTask>;
  held(claim: BoardClaim): BoardHeldTask;
  createTask(channel: string, task: BoardNewTask): Promise<BoardMessage>;
}

/** Which board the agent reads and writes, and as whom. */
export type BoardSettings = Readonly<typeof extension.config>;

export const BOARD_TEXT_LIMIT = 10_000;
export const BOARD_TAIL_LIMIT = 1_000;
export const BOARD_UPLOAD_LIMIT = 4 * 1024 * 1024;
export const BOARD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,31}$/u;
export const BOARD_CHANNEL_SELECTOR = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*\/?$/u;
export const BOARD_TASK_NOTE_LIMIT = 1_000;
export const BOARD_HOLD_KIND_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
export const DEFAULT_BOARD_PROFILE = "eve";

export function boardPostId(key: string): string {
  return `eve-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

export function boardAllows(
  can: BoardCan | undefined,
  channel: string,
  permission: string,
): boolean {
  if (can === undefined || can === "all") return true;
  const access = compileAccess(can as Can);
  const name = permission as Parameters<typeof access.can>[0];
  return channel.endsWith("/") ? access.at(name, channel) : access.can(name, channel);
}

export function boardErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

const handles = new Map<string, BoardHandle>();
const principals = new Map<string, Promise<{ principal: string; actor: string }>>();

type BoardRef = Pick<BoardSettings, "name" | "team" | "url" | "profile">;

function handleKey({ name, team, url }: BoardRef): string {
  return JSON.stringify([
    name ?? null,
    team ?? null,
    url?.trim().replace(/\/+$/u, "") || process.env.BOARD_URL?.trim() || null,
    process.env.BOARD_TOKEN ?? null,
  ]);
}

function createBoardHandle(board: BoardRef): BoardHandle {
  const { name, team, url } = board;
  const options = {
    ...(name !== undefined && { name }),
    ...(team !== undefined && { team }),
  };
  if (url === undefined) return boardHandle(options);
  const previous = process.env.BOARD_URL;
  process.env.BOARD_URL = url.trim();
  try {
    return boardHandle(options);
  } finally {
    if (previous === undefined) delete process.env.BOARD_URL;
    else process.env.BOARD_URL = previous;
  }
}

export function createBoardClient(board: BoardRef, can?: BoardCan): BoardClient {
  const profile = (board.profile ?? DEFAULT_BOARD_PROFILE).toLowerCase();
  if (!BOARD_NAME_PATTERN.test(profile)) {
    throw new Error(
      `Board profile "${board.profile}" is invalid: use a letter, then up to 31 letters, numbers, or hyphens.`,
    );
  }
  const key = handleKey(board);
  let base = handles.get(key);
  if (base === undefined) {
    base = createBoardHandle(board);
    handles.set(key, base);
  }
  const handle = withHints(base.as(profile, can === undefined ? undefined : { can: can as never }));
  const meKey = `${key}\n${profile}`;

  const held = (claim: BoardClaim): BoardHeldTask => {
    const task = handle.tasks.held(claim.taskId, { epoch: claim.epoch, token: claim.token });
    return {
      renew: async (lease) => (await task.renew(lease)).until,
      release: async () => void (await task.release()),
      complete: async (result) => void (await task.complete(result)),
      fail: async (reason) => void (await task.fail(reason)),
      block: async (reason, options) =>
        void (await task.block(
          reason,
          options?.kind === undefined ? undefined : { kind: options.kind },
        )),
    };
  };

  async function threadsPage(query: BoardThreadsQuery = {}): Promise<BoardThreadsPage> {
    const page = await handle.threads({
      ...query,
      ...(query.label !== undefined && { label: [...query.label] }),
    } as never);
    return {
      cursor: page.cursor,
      older: page.older ?? null,
      threads: page.threads.map((summary) => ({
        last: summary.last === null ? null : messageOf(summary.last),
        message: messageOf(summary.message),
        replies: summary.replies,
      })),
    };
  }

  return {
    profile,
    discovery: async () => await handle.discovery(),
    me: () => {
      let me = principals.get(meKey);
      if (me === undefined) {
        me = handle.me().then(
          ({ actor, principal }) => ({ actor, principal }),
          (error: unknown) => {
            principals.delete(meKey);
            throw error;
          },
        );
        principals.set(meKey, me);
      }
      return me;
    },
    watchers: async () => (await handle.watchers()).map(registrationOf),
    async register(input) {
      const watch = Object.fromEntries(
        Object.entries(input.watch).map(([name, { tail }]) => [name, { tail }]),
      );
      const where = input.path
        ? { branch: input.branch ?? null, path: input.path }
        : { url: input.url ?? null };
      const sync = input.sync?.map(({ key, platform }) => ({ key, platform }));
      return registrationOf(
        await handle.register({ ...where, watch, ...(sync !== undefined && { sync }) } as never),
      );
    },
    matches: async (options = {}) =>
      (
        await handle.matches({
          ...(options.limit !== undefined && { limit: options.limit }),
          ...(options.wait !== undefined && { wait: options.wait }),
        })
      ).map(matchOf),
    async ack(match, outcome = {}) {
      await handle.ack(match.id, {
        lease: match.lease,
        ...(outcome.error !== undefined && { error: outcome.error.slice(0, 500) }),
        ...(outcome.skip === true && { skip: true }),
      });
    },
    post: async (channel, post) => writtenOf(await handle.post(channel, postOf(post))),
    reply: async (id, post) => writtenOf(await handle.reply(id, postOf(post))),
    upload: async (file) =>
      await handle.upload({
        data: file.data as Uint8Array<ArrayBuffer>,
        name: file.name,
        ...(file.type !== undefined && { type: file.type }),
      }),
    async react(id, emoji, reaction = {}) {
      await handle.react(id, emoji, reaction.remove === true ? { remove: true } : {});
    },
    async label(id, change) {
      await handle.label(id, {
        ...(change.set !== undefined && { set: change.set }),
        ...(change.unset !== undefined && { unset: [...change.unset] }),
        ...(change.if !== undefined && { if: { ...change.if } }),
      });
    },
    async typing(id, status) {
      await handle.typing(id, status === undefined ? undefined : status.slice(0, 50));
    },
    thread: async (id, range = {}) =>
      threadOf(await handle.thread(id, range.after === undefined ? {} : { after: range.after })),
    linked: async (url) => threadOf(await handle.linked(url)),
    async threads(query = {}) {
      return (await threadsPage(query)).threads;
    },
    threadsPage,
    async schedules(query = {}) {
      return (await handle.schedules({ ...query })).map(scheduleOf);
    },
    async actors() {
      return (await handle.actors()).map((actor) => ({
        handle: actor.handle,
        id: actor.id,
        kind: actor.kind,
        name: actor.name,
      }));
    },
    channels: async () =>
      (await handle.channels()).channels.map((channel) => ({ path: channel.path })),
    download: async (attachmentId) => await handle.download(attachmentId),
    async schedule(target, options) {
      const schedule = await handle.schedule("re" in target ? { re: target.re } : target.channel, {
        text: options.text,
        ...(options.noSync !== undefined && { noSync: options.noSync }),
        ...(options.in !== undefined && { in: options.in }),
        ...(options.at !== undefined && { at: options.at }),
        ...(options.every !== undefined && { every: options.every }),
        ...(options.times !== undefined && { times: options.times }),
        ...(options.until !== undefined && { until: options.until }),
      } as never);
      return scheduleOf(schedule);
    },
    async cancelSchedule(id) {
      const { canceled } = await handle.cancelSchedule(id);
      return { canceled };
    },
    async claimReady(query) {
      const claim = await handle.tasks.claim({
        channel: query.channel,
        ...(query.label !== undefined && { label: { ...query.label } }),
        ...(query.from !== undefined && query.from.length > 0 && { from: [...query.from] }),
        ...(query.lease !== undefined && { lease: query.lease }),
      });
      return claim === null ? null : claimedOf(claim);
    },
    claim: async (taskId, lease) =>
      claimedOf(await handle.tasks.claim(taskId, lease === undefined ? {} : { lease })),
    held,
    async createTask(channel, task) {
      const created = await handle.tasks.create(channel, {
        text: task.text,
        ...(task.labels !== undefined && { labels: { ...task.labels } }),
        ...(task.needs !== undefined && { needs: [...task.needs] }),
        ...(task.noSync !== undefined && { noSync: task.noSync }),
        ...(task.id !== undefined && { id: task.id }),
      });
      return messageOf(created.task);
    },
  };
}

function claimedOf(claim: {
  readonly epoch: number;
  readonly token: string;
  readonly until: string;
  readonly task: MessageView;
}): BoardClaimedTask {
  const { epoch, token, until } = claim;
  return { epoch, task: messageOf(claim.task), taskId: claim.task.id, token, until };
}

function postOf(post: BoardPostOptions) {
  return {
    text: post.text,
    ...(post.labels !== undefined && { labels: { ...post.labels } }),
    ...(post.noSync !== undefined && { noSync: post.noSync }),
    ...(post.id !== undefined && { id: post.id }),
    ...(post.attachments !== undefined && { attachments: [...post.attachments] }),
    ...(post.after !== undefined && { after: post.after }),
  };
}

export function withHints<T extends object>(target: T): T {
  return new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key);
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(value, object, args);
          if (result instanceof Promise)
            return result.catch((error: unknown) => Promise.reject(hinted(error)));
          return typeof result === "object" && result !== null ? withHints(result) : result;
        };
      }
      return typeof value === "object" && value !== null ? withHints(value) : value;
    },
  });
}

function hinted(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const hint = (error as { readonly hint?: unknown }).hint;
  if (typeof hint === "string" && hint.length > 0 && !error.message.includes(hint)) {
    error.message = `${error.message} ${hint}`;
  }
  return error;
}

function messageOf(view: MessageView): BoardMessage {
  const { author, by, schedule, task } = view;
  return {
    attachments: view.attachments.map(({ id, name, size, type }) => ({ id, name, size, type })),
    author:
      author === null ? null : { handle: author.handle, kind: author.kind, name: author.name },
    by: { actor: by.actor, principal: by.principal, profile: by.profile },
    channel: view.channel,
    createdAt: view.createdAt,
    deleted: view.deleted,
    id: view.id,
    labels: { ...view.labels },
    noSync: view.noSync === true,
    re: view.re,
    text: view.text,
    thread: view.thread,
    ...(schedule !== undefined && { schedule: { id: schedule.id, n: schedule.n } }),
    ...(task !== undefined && {
      task: {
        blocked:
          task.blocked === null ? null : { kind: task.blocked.kind, reason: task.blocked.reason },
        claim: task.claim === null ? null : { actor: task.claim.actor, until: task.claim.until },
        owner: task.owner,
        reason: task.reason,
        result: task.result,
        state: task.state,
      },
    }),
  };
}

function writtenOf(written: Written<MessageView>): BoardWrittenMessage {
  const unknown = (written.mentions ?? [])
    .filter((mention) => mention.actor === null)
    .map((mention) => mention.written.replace(/^@/u, ""));
  return unknown.length === 0
    ? messageOf(written)
    : { ...messageOf(written), unknownMentions: unknown };
}

function threadOf(view: {
  readonly message: MessageView;
  readonly replies: readonly MessageView[];
}): BoardThread {
  return { message: messageOf(view.message), replies: view.replies.map(messageOf) };
}

function matchOf(match: MatchView): BoardMatch {
  return {
    attempt: match.attempt,
    event: {
      createdAt: match.event.createdAt,
      cursor: match.event.cursor,
      type: match.event.type,
      ...(match.event.message !== undefined && { message: messageOf(match.event.message) }),
    },
    id: match.id,
    lease: match.lease,
    watcher: match.watcher,
  };
}

function registrationOf(registration: {
  readonly owner: string;
  readonly hash: string;
  readonly url: string | null;
  readonly path?: string;
  readonly branch?: string;
  readonly watch: Readonly<Record<string, { readonly tail: string }>>;
  readonly sync?: readonly BoardSyncEntry[];
}): BoardRegistration {
  return {
    hash: registration.hash,
    owner: registration.owner,
    sync: (registration.sync ?? []).map(({ key, platform }) => ({ key, platform })),
    url: registration.url,
    ...(registration.path !== undefined && { path: registration.path }),
    ...(registration.branch !== undefined && { branch: registration.branch }),
    watch: registration.watch,
  };
}

function scheduleOf(schedule: ScheduleView): BoardSchedule {
  return {
    channel: schedule.channel,
    id: schedule.id,
    next: schedule.next,
    re: schedule.re,
    state: schedule.state,
    text: schedule.text,
  };
}
